// Read-only client for the Steam Storefront API (store.steampowered.com). This
// API is unofficial but public and needs no key — it backs all the game/store
// tools. Region/locale-aware via cc (country) and l (language). Wraps the
// generic HttpClient with a polite rate limiter (the store is burst-sensitive)
// and a TTL cache; all shaping lives in ../format/storefront.ts.
import { HttpClient } from "../lib/http.ts";
import { RateLimiter } from "../lib/rateLimit.ts";
import { ApiError } from "../lib/errors.ts";
import { noteDegraded, optionalParts } from "../lib/call.ts";
import { call } from "../lib/endpoint.ts";
import { Steam } from "./endpoints.ts";
import {
  detailApp,
  summarizeFeatured,
  summarizePrices,
  summarizeReviewHistogram,
  summarizeSpecials,
  type FeaturedResponse,
  type PriceDetailsResponse,
  usableAppEntry,
} from "../format/storefront.ts";
import type { PurchasePrices } from "../format/store.ts";
import type { Logger } from "../lib/logger.ts";
import type { Config } from "../config.ts";

// appdetails sections detailApp reads ("basic" carries name/type/description/
// is_free/required_age/dlc/requirements/languages/website/controller support).
// Requested by name instead of the whole payload: 40-60% smaller (Elden Ring
// 32 → 19 KB, Portal 2 28 → 11 KB) with every key detailApp reads byte-identical
// (verified live 2026-10-20 on a game, a DLC, a free game and Portal 2) — the
// rest is screenshots, movies, long HTML descriptions and package groups.
const APPDETAILS_FILTERS = [
  "basic",
  "price_overview",
  "platforms",
  "metacritic",
  "genres",
  "categories",
  "release_date",
  "developers",
  "publishers",
  "achievements",
  "demos",
  "recommendations",
  "content_descriptors",
  "fullgame",
  "drm_notice",
  "ext_user_account_notice",
].join(",");

/** The one StoreServiceClient method this client needs (clients/storeService.ts):
 *  authoritative base-game prices, used to correct what the Storefront API says.
 *  Declared as a narrow interface rather than importing the class, so the
 *  Storefront client stays independent of the Web API client it's wired to. */
export interface PurchasePriceSource {
  getPurchasePrices(appids: number[], country?: string, language?: string): Promise<PurchasePrices>;
  getGamePurchasePrice(appid: number, country?: string, language?: string): Promise<PurchasePrices>;
}

export class StorefrontClient {
  readonly #http: HttpClient;
  readonly #cc: string;
  readonly #l: string;
  // Every price this client reports is corrected through this: see
  // format/storefront.ts's overridePrice() for what's wrong with the numbers
  // the Storefront API itself returns.
  readonly #pricing: PurchasePriceSource;

  constructor(config: Config, logger: Logger, pricing: PurchasePriceSource) {
    this.#cc = config.country;
    this.#l = config.language;
    this.#pricing = pricing;
    const limiter = new RateLimiter(config.storeMinIntervalMs);
    this.#http = new HttpClient({
      baseUrl: config.steamStoreBaseUrl,
      logger,
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      beforeRequest: (signal) => limiter.acquire(signal),
      cacheTtlMs: config.cacheTtlMs,
    });
  }

  async getGame(
    appid: number,
    country?: string,
    language?: string,
  ): Promise<Record<string, unknown>> {
    const cc = country ?? this.#cc;
    const l = language ?? this.#l;
    // In parallel, not sequentially: the appid is already known, so correcting
    // the price costs a request but no extra wall-clock. Each request is cached
    // on its own (lib/cache.ts), so a failed correction never taints the
    // cached details, and a warm hit makes no upstream call at all.
    const [res, prices] = await Promise.all([
      call(
        this.#http,
        Steam.GameDetails,
        { appids: appid, cc, l, filters: APPDETAILS_FILTERS },
        { cache: true },
      ),
      this.#pricing.getGamePurchasePrice(appid, cc, l),
    ]);
    // The body rule holds this entry; only Steam's success:false is a "no".
    const entry = res[String(appid)]!;
    if (!entry.success) {
      // appdetails answers {success:false} both for "no such app" and for "not
      // sold in this country", so naming only the first sends the agent off to
      // re-search a perfectly good appid. Confirmed live: appid 1174180 (Red
      // Dead Redemption 2) is a full record under cc=US and success:false
      // under cc=RU. A game removed from the store answers the same in every
      // region (2026-11-05: 219820, 264040, 303700, 453170, all still on a
      // public wishlist), so that's named too.
      throw new ApiError({
        code: "not_found",
        message: `appdetails success:false for appid ${appid} cc ${cc}`,
        detail:
          `No Steam app with id ${appid} in region ${cc.toUpperCase()} — either the appid ` +
          `doesn't exist or was removed from the store, or it isn't available in that ` +
          `country (try another \`country\`).`,
      });
    }
    return detailApp(entry.data, prices[String(appid)]);
  }

  // Batch prices for many appids in one place. appdetails accepts a comma-list
  // with filters=price_overview; we chunk to keep URLs/responses bounded and
  // merge. Not cached — prices change and the appid set varies per call.
  //
  // Promise.allSettled, not a sequential await: summarizePrices emits
  // `available:null` (unknown) for any appid missing from the merged map, and
  // this tool's contract is "one row per id, never dropped" — so one chunk's
  // transient failure should cost that chunk's prices, not the whole call. Awaiting in a
  // bare loop threw the successful chunks away too. (Mirrors web.ts's
  // #playerSummaries, whose chunk loop was converted for the same reason.)
  async getPrices(appids: number[], country?: string): Promise<Record<string, unknown>> {
    const cc = country ?? this.#cc;
    const CHUNK = 100;
    const chunks: number[][] = [];
    for (let i = 0; i < appids.length; i += CHUNK) chunks.push(appids.slice(i, i + CHUNK));
    // appdetails still supplies availability, whether a price exists at all
    // (priced:false otherwise) and the currency code (which GetItems never
    // returns) for every row; the parallel lookup only corrects the amounts.
    // getPurchasePrices rejects only on a bug or a cancel (a Steam failure is a
    // noted gap per chunk), so this outer Promise.all can't let an upstream
    // failure defeat the allSettled around the appdetails chunks.
    const [settled, overrides] = await Promise.all([
      Promise.allSettled(
        chunks.map((chunk) =>
          call(this.#http, Steam.AppDetails, {
            appids: chunk.join(","),
            cc,
            filters: "price_overview",
          }),
        ),
      ),
      this.#pricing.getPurchasePrices(appids, cc),
    ]);
    // Every chunk failing is an outage, not "no game has a price" — surface it
    // rather than answering with a full list of available:false rows. Guarded on
    // chunks.length, not fulfilled.length alone: an empty appids list produces
    // no chunks, so `settled[0]` would be undefined and reading `.reason` off it
    // threw a TypeError that reached the agent as a raw "Cannot read properties
    // of undefined" (now an internal error). The tool's schema is .nonempty() so this is
    // unreachable through get_prices today — but summarizePrices already answers
    // an empty list correctly, and a client method shouldn't depend on one
    // caller's validation to avoid crashing.
    // Before optionalParts, which would note (and log) each chunk as a gap
    // in a partial answer there won't be. A bug in any chunk goes first: an
    // upstream failure must not hide it.
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (chunks.length > 0 && failed.length === chunks.length) {
      throw (failed.find((r) => !(r.reason instanceof ApiError)) ?? failed[0]!).reason;
    }
    const parts = optionalParts(settled, (i) => `Prices of ${chunks[i]!.length} appids`);
    const merged: Record<string, unknown> = Object.assign({}, ...parts);
    // Per row: an entry that doesn't fit (priceEntryInput) is that price's gap
    // alone, noted like a failed chunk's — left out here, decided once, so
    // summarizePrices reads it as no entry (available:null).
    const rows: PriceDetailsResponse = {};
    for (const [id, e] of Object.entries(merged)) if (usableAppEntry(e)) rows[id] = e;
    const odd = [
      ...new Set(
        chunks.flatMap((chunk, i) =>
          settled[i]!.status === "fulfilled" ? chunk.filter((id) => !(id in rows)) : [],
        ),
      ),
    ];
    if (odd.length) {
      noteDegraded(
        `Prices of ${odd.length} appids`,
        new ApiError({
          code: "bad_response",
          message: `appdetails had no usable entry for ${odd.length} appids`,
          retryable: true,
        }),
      );
    }
    return summarizePrices(rows, appids, overrides);
  }

  // Review trend over time (monthly history + recent daily). Cached briefly.
  async getReviewHistogram(appid: number): Promise<Record<string, unknown>> {
    const res = await call(
      this.#http,
      Steam.ReviewHistogram,
      { appid, l: this.#l },
      { cache: true },
    );
    return summarizeReviewHistogram(res);
  }

  // featuredcategories backs both getFeatured (all sections) and getSpecials (just
  // the specials slice): one cached request per cc/l, so calling either — or
  // both — hits the store at most once; each shapes the payload itself.
  #featured(cc: string, l: string): Promise<FeaturedResponse> {
    return call(this.#http, Steam.FeaturedCategories, { cc, l }, { cache: true });
  }

  async getFeatured(country?: string, language?: string): Promise<Record<string, unknown>> {
    return summarizeFeatured(await this.#featured(country ?? this.#cc, language ?? this.#l));
  }

  async getSpecials(country?: string, language?: string): Promise<Record<string, unknown>> {
    return summarizeSpecials(await this.#featured(country ?? this.#cc, language ?? this.#l));
  }
}
