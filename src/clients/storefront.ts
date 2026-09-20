// Read-only client for the Steam Storefront API (store.steampowered.com). This
// API is unofficial but public and needs no key — it backs all the game/store
// tools. Region/locale-aware via cc (country) and l (language). Wraps the
// generic HttpClient with a polite rate limiter (the store is burst-sensitive)
// and a TTL cache; all shaping lives in ../format/storefront.js.
import { HttpClient } from "../lib/http.js";
import { RateLimiter } from "../lib/rateLimit.js";
import { TtlCache } from "../lib/cache.js";
import { ApiError } from "../lib/errors.js";
import {
  detailApp,
  summarizeFeatured,
  summarizePrices,
  summarizeReviewHistogram,
  summarizeReviews,
  summarizeSearch,
  summarizeSpecials,
  type FeaturedResponse,
  type PriceDetailsResponse,
  type ReviewHistogramResponse,
  type ReviewsResponse,
  type SearchResponse,
  type StoreApp,
} from "../format/storefront.js";
import type { Logger } from "../lib/logger.js";
import type { Config } from "../config.js";

type AppDetailsResponse = Record<string, { success?: boolean; data?: StoreApp }>;

export class StorefrontClient {
  readonly #http: HttpClient;
  readonly #cache: TtlCache;
  readonly #cc: string;
  readonly #l: string;

  constructor(config: Config, logger: Logger) {
    this.#cc = config.country;
    this.#l = config.language;
    const limiter = new RateLimiter(config.storeMinIntervalMs);
    this.#http = new HttpClient({
      baseUrl: config.steamStoreBaseUrl,
      logger,
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      beforeRequest: () => limiter.acquire(),
      hasCredentials: false,
    });
    this.#cache = new TtlCache(config.cacheTtlMs);
  }

  // storesearch backs both title search and name→appid resolution. country (cc)
  // and language (l) fall back to the configured defaults; tools expose them as
  // optional per-call overrides (e.g. compare prices by region).
  #search(term: string, country?: string, language?: string): Promise<SearchResponse> {
    return this.#http.getJson<SearchResponse>("api/storesearch/", {
      query: { term, l: language ?? this.#l, cc: country ?? this.#cc },
    });
  }

  async searchGames(
    term: string,
    country?: string,
    language?: string,
  ): Promise<Record<string, unknown>> {
    return summarizeSearch(await this.#search(term, country, language));
  }

  // Resolve a game title to its appid via store search (top match), so callers
  // can pass a name instead of an appid. Returns null when nothing matches.
  async resolveAppId(term: string, country?: string, language?: string): Promise<number | null> {
    const res = await this.#search(term, country, language);
    return res.items?.find((i) => typeof i.id === "number")?.id ?? null;
  }

  async getGame(
    appid: number,
    country?: string,
    language?: string,
  ): Promise<Record<string, unknown>> {
    const cc = country ?? this.#cc;
    const l = language ?? this.#l;
    return this.#cache.wrapStaleOnError(`app:${appid}:${cc}:${l}`, async () => {
      const res = await this.#http.getJson<AppDetailsResponse>("api/appdetails", {
        query: { appids: appid, cc, l },
      });
      const entry = res[String(appid)];
      if (!entry?.success || !entry.data) {
        // appdetails answers {success:false} both for "no such app" and for "not
        // sold in this country", so naming only the first sends the agent off to
        // re-search a perfectly good appid. Confirmed live: appid 1174180 (Red
        // Dead Redemption 2) is a full record under cc=US and success:false
        // under cc=RU.
        throw new ApiError({
          code: "not_found",
          message:
            `No Steam app with id ${appid} in region ${cc.toUpperCase()} — either the appid ` +
            `doesn't exist, or it isn't available in that country (try another \`country\`).`,
        });
      }
      return detailApp(entry.data);
    });
  }

  // Not cached: reviews are paginated and change as users post. `reviewLanguage`
  // filters by review language ("all" = any); `reviewType` = all|positive|negative.
  async getReviews(
    appid: number,
    max: number,
    reviewLanguage = "all",
    reviewType = "all",
  ): Promise<Record<string, unknown>> {
    const res = await this.#http.getJson<ReviewsResponse>(`appreviews/${appid}`, {
      query: {
        json: 1,
        num_per_page: max,
        language: reviewLanguage,
        review_type: reviewType,
        purchase_type: "all",
      },
    });
    return summarizeReviews(res, max);
  }

  // Batch prices for many appids in one place. appdetails accepts a comma-list
  // with filters=price_overview; we chunk to keep URLs/responses bounded and
  // merge. Not cached — prices change and the appid set varies per call.
  //
  // Promise.allSettled, not a sequential await: summarizePrices already emits
  // `available:false` for any appid missing from the merged map, and this tool's
  // contract is "one row per id, never dropped" — so one chunk's transient
  // failure should cost that chunk's prices, not the whole call. Awaiting in a
  // bare loop threw the successful chunks away too. (Mirrors web.ts's
  // #playerSummaries, whose chunk loop was converted for the same reason.)
  async getPrices(appids: number[], country?: string): Promise<Record<string, unknown>> {
    const cc = country ?? this.#cc;
    const CHUNK = 100;
    const chunks: number[][] = [];
    for (let i = 0; i < appids.length; i += CHUNK) chunks.push(appids.slice(i, i + CHUNK));
    const settled = await Promise.allSettled(
      chunks.map((chunk) =>
        this.#http.getJson<PriceDetailsResponse>("api/appdetails", {
          query: { appids: chunk.join(","), cc, filters: "price_overview" },
        }),
      ),
    );
    // Every chunk failing is an outage, not "no game has a price" — surface it
    // rather than answering with a full list of available:false rows. Guarded on
    // chunks.length, not fulfilled.length alone: an empty appids list produces
    // no chunks, so `settled[0]` would be undefined and reading `.reason` off it
    // threw a TypeError that guard() rendered as "Unexpected error: Cannot read
    // properties of undefined". The tool's schema is .nonempty() so this is
    // unreachable through get_prices today — but summarizePrices already answers
    // an empty list correctly, and a client method shouldn't depend on one
    // caller's validation to avoid crashing.
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    if (chunks.length > 0 && fulfilled.length === 0) {
      throw (settled[0] as PromiseRejectedResult).reason;
    }
    const merged: PriceDetailsResponse = {};
    for (const r of fulfilled) Object.assign(merged, r.value);
    return summarizePrices(merged, appids);
  }

  // Review trend over time (monthly history + recent daily). Cached briefly.
  async getReviewHistogram(appid: number): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(`hist:${appid}:${this.#l}`, async () => {
      const res = await this.#http.getJson<ReviewHistogramResponse>(`appreviewhistogram/${appid}`, {
        query: { l: this.#l },
      });
      return summarizeReviewHistogram(res);
    });
  }

  // featuredcategories backs both getFeatured (all sections) and getSpecials (just
  // the specials slice). Cache the RAW payload once per cc/l, so calling either —
  // or both — hits the store at most once; each shapes the cached payload itself.
  #featured(cc: string, l: string): Promise<FeaturedResponse> {
    return this.#cache.wrapStaleOnError(`featured:${cc}:${l}`, () =>
      this.#http.getJson<FeaturedResponse>("api/featuredcategories", { query: { cc, l } }),
    );
  }

  async getFeatured(country?: string, language?: string): Promise<Record<string, unknown>> {
    return summarizeFeatured(await this.#featured(country ?? this.#cc, language ?? this.#l));
  }

  async getSpecials(country?: string, language?: string): Promise<Record<string, unknown>> {
    return summarizeSpecials(await this.#featured(country ?? this.#cc, language ?? this.#l));
  }
}
