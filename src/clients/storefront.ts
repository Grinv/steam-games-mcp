// Read-only client for the Steam Storefront API (store.steampowered.com). This
// API is unofficial but public and needs no key — it backs all the game/store
// tools. Region/locale-aware via cc (country) and l (language). Wraps the
// generic HttpClient with a polite rate limiter (the store is burst-sensitive)
// and a TTL cache; all shaping lives in ../format.js.
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
} from "../format.js";
import type { Logger } from "../lib/logger.js";
import type { Config } from "../config.js";

type AppDetailsResponse = Record<string, { success?: boolean; data?: StoreApp }>;

export class StorefrontClient {
  readonly #http: HttpClient;
  readonly #cache: TtlCache<Record<string, unknown>>;
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
    });
    this.#cache = new TtlCache(config.cacheTtlMs);
  }

  // country (cc) and language (l) fall back to the configured defaults; tools
  // expose them as optional per-call overrides (e.g. compare prices by region).
  async searchGames(
    term: string,
    country?: string,
    language?: string,
  ): Promise<Record<string, unknown>> {
    const res = await this.#http.getJson<SearchResponse>("api/storesearch/", {
      query: { term, l: language ?? this.#l, cc: country ?? this.#cc },
    });
    return summarizeSearch(res);
  }

  // Resolve a game title to its appid via store search (top match), so callers
  // can pass a name instead of an appid. Returns null when nothing matches.
  async resolveAppId(term: string, country?: string, language?: string): Promise<number | null> {
    const res = await this.#http.getJson<SearchResponse>("api/storesearch/", {
      query: { term, l: language ?? this.#l, cc: country ?? this.#cc },
    });
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
        throw new ApiError({ code: "not_found", message: `No Steam app with id ${appid}` });
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
  async getPrices(appids: number[], country?: string): Promise<Record<string, unknown>> {
    const cc = country ?? this.#cc;
    const CHUNK = 100;
    const merged: PriceDetailsResponse = {};
    for (let i = 0; i < appids.length; i += CHUNK) {
      const chunk = appids.slice(i, i + CHUNK);
      const res = await this.#http.getJson<PriceDetailsResponse>("api/appdetails", {
        query: { appids: chunk.join(","), cc, filters: "price_overview" },
      });
      Object.assign(merged, res);
    }
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

  // Featured/specials change often; cache briefly via the shared TTL.
  async getFeatured(country?: string, language?: string): Promise<Record<string, unknown>> {
    const cc = country ?? this.#cc;
    const l = language ?? this.#l;
    return this.#cache.wrapStaleOnError(`featured:${cc}:${l}`, async () => {
      const res = await this.#http.getJson<FeaturedResponse>("api/featuredcategories", {
        query: { cc, l },
      });
      return summarizeFeatured(res);
    });
  }

  async getSpecials(country?: string, language?: string): Promise<Record<string, unknown>> {
    const cc = country ?? this.#cc;
    const l = language ?? this.#l;
    return this.#cache.wrapStaleOnError(`specials:${cc}:${l}`, async () => {
      const res = await this.#http.getJson<FeaturedResponse>("api/featuredcategories", {
        query: { cc, l },
      });
      return summarizeSpecials(res);
    });
  }
}
