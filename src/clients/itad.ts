// Read-only client for the IsThereAnyDeal (ITAD) API v2. ITAD aggregates deals
// and price history across stores; here it's the legitimate source for the
// "SteamDB-style" features Steam's own APIs don't expose (catalog-wide discounts
// + historical lows). Needs a free key (https://isthereanydeal.com/apps/) sent
// as the `key` query param. By default we scope deals to the Steam shop (id 61).
// Docs: https://docs.isthereanydeal.com/
import { HttpClient } from "../lib/http.js";
import { RateLimiter } from "../lib/rateLimit.js";
import { TtlCache } from "../lib/cache.js";
import { ApiError } from "../lib/errors.js";
import {
  summarizeDeals,
  summarizeGameInfo,
  summarizePriceHistory,
  type ItadDealsResponse,
  type ItadGameInfoResponse,
  type ItadHistoryResponse,
  type ItadLookupResponse,
} from "../format.js";
import type { Logger } from "../lib/logger.js";
import type { Config } from "../config.js";

type Query = Record<string, string | number | boolean | undefined>;

/** ITAD's numeric id for the Steam shop. */
const STEAM_SHOP_ID = 61;

export interface DealsParams {
  min_cut?: number;
  max_price?: number;
  sort?: string;
  limit?: number;
  offset?: number;
  steam_only?: boolean;
  country?: string;
}

export class ItadClient {
  readonly #http: HttpClient;
  readonly #cache: TtlCache<Record<string, unknown>>;
  readonly #key: string | undefined;
  readonly #country: string;
  /** True when an ITAD key is configured; tools short-circuit otherwise. */
  readonly configured: boolean;

  constructor(config: Config, logger: Logger) {
    this.#key = config.itadApiKey;
    this.#country = config.country;
    this.configured = Boolean(config.itadApiKey);
    const limiter = new RateLimiter(config.apiMinIntervalMs);
    this.#http = new HttpClient({
      baseUrl: config.itadBaseUrl,
      logger,
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      beforeRequest: () => limiter.acquire(),
    });
    this.#cache = new TtlCache(config.cacheTtlMs);
  }

  #get<T>(path: string, query: Query): Promise<T> {
    return this.#http.getJson<T>(path, { query: { key: this.#key, ...query } });
  }

  // Current deals across the catalog, biggest discount first. Scoped to Steam by
  // default; `min_cut` filters by minimum discount %. Not cached (deals churn).
  async getDeals(p: DealsParams): Promise<Record<string, unknown>> {
    const query: Query = {
      country: p.country ?? this.#country,
      // ITAD sort keys: -cut (default, biggest discount), price, -price, -time, …
      sort: p.sort ?? "-cut",
      limit: p.limit ?? 50,
      offset: p.offset ?? 0,
    };
    if (p.steam_only !== false) query.shops = STEAM_SHOP_ID;
    if (typeof p.min_cut === "number") query.cut = p.min_cut;
    const res = await this.#get<ItadDealsResponse>("deals/v2", query);
    // ITAD has no simple max-price query param, so cap client-side over the
    // returned page (documented as such on the tool).
    if (typeof p.max_price === "number" && Array.isArray(res.list)) {
      res.list = res.list.filter((it) => (it.deal?.price?.amount ?? Infinity) <= p.max_price!);
    }
    return summarizeDeals(res);
  }

  // Price history for a Steam game: resolve appid → ITAD id, then fetch history.
  // `since` (ISO date) widens the window — ITAD defaults to the last 3 months,
  // so pass an older date for a true all-time low. Default goes back far enough
  // to cover the modern catalogue.
  async getPriceHistory(
    appid: number,
    country?: string,
    since = "2015-01-01T00:00:00Z",
  ): Promise<Record<string, unknown>> {
    const cc = country ?? this.#country;
    return this.#cache.wrapStaleOnError(`itad-hist:${appid}:${cc}:${since}`, async () => {
      const id = await this.#resolveId(appid);
      const res = await this.#get<ItadHistoryResponse>("games/history/v2", {
        id,
        country: cc,
        shops: STEAM_SHOP_ID,
        since,
      });
      return summarizePriceHistory(res, null);
    });
  }

  // Rich one-call card (Steam appid + review score + current players + tags),
  // by Steam appid (resolved to an ITAD id first) or a known ITAD id.
  async getGameInfo(opts: { appid?: number; itadId?: string }): Promise<Record<string, unknown>> {
    const id = opts.itadId ?? (await this.#resolveId(opts.appid!));
    return this.#cache.wrapStaleOnError(`itad-info:${id}`, async () => {
      const res = await this.#get<ItadGameInfoResponse>("games/info/v2", { id });
      return summarizeGameInfo(res);
    });
  }

  // Steam appid → ITAD game id (UUID), throwing a clear error when unmapped.
  async #resolveId(appid: number): Promise<string> {
    const lookup = await this.#get<ItadLookupResponse>("games/lookup/v1", { appid });
    if (!lookup.found || !lookup.game?.id) {
      throw new ApiError({
        code: "not_found",
        message: `IsThereAnyDeal has no game mapped to Steam appid ${appid}`,
      });
    }
    return lookup.game.id;
  }
}
