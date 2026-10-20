// Client for Steam's undocumented, keyless "store service" APIs
// (IStoreBrowseService/GetItems, IStoreQueryService/Query, IStoreService/GetTagList,
// IWishlistService/GetWishlistSortedFiltered) — the modern store-card backend
// behind get_items, discover_games and get_wishlist's include_details. Split out
// of SteamWebClient (clients/web.ts) to mirror format/'s web.ts/store.ts split:
// this class owns everything that formats through format/store.ts's shared card
// builder. The basic (light) get_wishlist and get_followed_games stay on
// SteamWebClient, matching format/web.ts's ownership of their formatters.
//
// Shares the parent's HttpClient/TtlCache (passed in) rather than owning its
// own — both clients hit the same api.steampowered.com host and must honor one
// rate limiter and one cache, not one each.
import { ApiError, withFallbackOn } from "../lib/errors.js";
import type { TtlCache } from "../lib/cache.js";
import { notFound } from "../format/shared.js";
import {
  computeFavoriteTagWeights,
  summarizeDiscover,
  summarizeItems,
  summarizePurchasePrices,
  summarizeRecommendations,
  summarizeSearchSuggestions,
  summarizeWishlistDetailed,
  type PurchasePrices,
  type SearchSuggestionsResponse,
  type StoreQueryResponse,
  type WishlistDetailedResponse,
} from "../format/store.js";
import {
  chartAppids,
  itemNames,
  summarizeConcurrentPlayers,
  summarizeMostPlayed,
  summarizeMostPlayedDeck,
  summarizeTopSellers,
  type ConcurrentPlayersResponse,
  type DeckMostPlayedResponse,
  type MostPlayedResponse,
  type TopSellersResponse,
} from "../format/charts.js";
import type { ChartName } from "../format/charts.js";
import {
  summarizeTagList,
  type CompatFilters,
  type GetTagListResponse,
  type StoreItemsResponse,
  type TagMap,
} from "../format/storeCard.js";

type Query = Record<string, string | number | boolean | undefined>;
// The parent's authenticated `#get` (bakes in the key, sent when present per
// AGENTS.md's keyless caveat — these endpoints answer without one too).
type Get = <T>(path: string, query: Query, opts?: { hasCredentials?: boolean }) => Promise<T>;

// The include_* flags every store-service card call needs (basic info, reviews,
// release, native platforms + compat, popular tags). tagCount varies: fewer for
// display-only (get_items), more when tags are also filtered (discover/wishlist).
const storeCardDataRequest = (tagCount: number) => ({
  include_basic_info: true,
  include_reviews: true,
  include_release: true,
  include_platforms: true,
  include_tag_count: tagCount,
  // Steam's best_purchase_option is routinely a bundle of this app AND another
  // game, so every card needs the app's own package alongside it — see
  // format/storeCard.ts's ownPurchaseOption() for why this is asked up front
  // rather than fetched in a follow-up.
  include_all_purchase_options: true,
});

// getRecommendedGames tuning: how many of the player's most-played owned games
// feed the tag-weighting step, how many of the resulting top tags are surfaced
// as `based_on_tags`, and how big a catalog page is scored against them.
// getPurchasePrices' batch size. GetItems is GET-only (POST answers 405) and the
// whole request travels in the `input_json` query param, so the ceiling is
// Steam's ~8 KB URI limit rather than a documented item count — measured live:
// 220 appids answer 200, 250 answer HTTP 414. 150 keeps room for longer appids.
export const PRICE_LOOKUP_CHUNK = 150;

export const FAVORITE_TAG_SAMPLE_SIZE = 30;
const BASED_ON_TAGS_LIMIT = 6;
export const RECOMMENDATION_POOL_SIZE = 300;

export class StoreServiceClient {
  readonly #get: Get;
  readonly #cache: TtlCache;
  readonly #l: string;
  readonly #country: string;

  constructor(opts: { get: Get; cache: TtlCache; language: string; country: string }) {
    this.#get = opts.get;
    this.#cache = opts.cache;
    this.#l = opts.language;
    this.#country = opts.country;
  }

  // Tag dictionary (tagid → localized name) from IStoreService/GetTagList
  // (keyless). Store items carry only numeric tagids; this resolves them to the
  // readable tag names surfaced on each card. Cached per language and tiny
  // (~450 entries, stable), so one fetch serves many cards.
  // Returns null (rather than throwing) on upstream failure — callers that only
  // DISPLAY tags can degrade gracefully (empty tags list); callers that FILTER
  // by tags must check for null themselves and fail loudly instead of silently
  // returning zero matches (an empty dictionary would make every tag filter
  // reject every item, indistinguishable from "no games matched").
  async #tagNames(language: string): Promise<TagMap | null> {
    try {
      return await this.#cache.wrapStaleOnError(`tags:${language}`, async () => {
        const res = await this.#get<GetTagListResponse>(
          "IStoreService/GetTagList/v1/",
          { language },
          { hasCredentials: false },
        );
        const map = summarizeTagList(res);
        // GetTagList answers an unrecognized `language` (an ISO code like "ru"
        // instead of Steam's "russian") with 200 and an empty body rather than
        // an error, so an empty dictionary means the fetch failed — no language
        // legitimately has zero tags. Throw so it never reaches the cache and
        // the catch below reports it as unavailable, which is what makes the
        // filter path above fail loudly instead of matching nothing.
        if (Object.keys(map).length === 0)
          throw new ApiError({
            code: "unknown",
            message: `Steam returned an empty tag dictionary for language "${language}".`,
            retryable: true,
          });
        return map;
      });
    } catch {
      return null;
    }
  }

  // Throws when a tags filter was requested but the tag dictionary is
  // unavailable — never silently treats that as "nothing matched".
  #requireTagMapIfFiltering(
    tags: string[] | undefined,
    tagMap: TagMap | null,
    language: string,
  ): TagMap | undefined {
    if (tagMap !== null) return tagMap;
    if (!tags?.length) return undefined;
    // "unknown" is the one ApiErrorCode whose mapped message (lib/result.ts)
    // includes our own text verbatim — the other codes render a fixed,
    // generic sentence per code and would swallow this explanation.
    throw new ApiError({
      code: "unknown",
      message:
        "could not fetch Steam's tag dictionary right now, so the `tags` filter can't be " +
        `reliably applied. Check that language "${language}" is one of Steam's full language ` +
        "names (english, russian, schinese — not an ISO code like en/ru/zh), then retry, or " +
        "drop `tags` to see unfiltered results.",
      retryable: true,
    });
  }

  // Shared shape behind getItems/#queryCatalog/getWishlistDetailed: fetch the
  // store-service page alongside the (cached) tag dictionary in parallel, then
  // resolve/guard the tag map through the same rule every caller needs.
  // tagsBeingFiltered is omitted by getItems, which never filters by tags.
  async #fetchWithTags<T>(
    path: string,
    query: Query,
    language: string,
    tagsBeingFiltered?: string[],
  ): Promise<{ res: T; tagMap: TagMap | undefined }> {
    const [res, tagMap] = await Promise.all([
      this.#get<T>(path, query, { hasCredentials: false }),
      this.#tagNames(language),
    ]);
    return { res, tagMap: this.#requireTagMapIfFiltering(tagsBeingFiltered, tagMap, language) };
  }

  // Title search (search_games, and the is_it_worth_buying prompt's completions)
  // via the store's own search-suggestion service rather than the Storefront's
  // storesearch: same relevance order (compared live), but up to 100 results
  // instead of 10, a real match total, the item type, and GetItems-style store
  // items in the same response — so prices come from the app's own package
  // like every card, with no second lookup. `start` is ignored upstream (always
  // 0), so there is no paging past `limit`. include_extra_details is only for
  // metacritic: it roughly doubles the upstream payload (~+0.1 s at 50 results).
  async searchGames(
    term: string,
    opts: { country?: string; language?: string; limit?: number; gamesOnly?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const res = await this.#get<SearchSuggestionsResponse>(
      "IStoreQueryService/SearchSuggestions/v1/",
      {
        input_json: JSON.stringify({
          search_term: term,
          max_results: opts.limit ?? 10,
          // Server-side, so `limit` is filled with games rather than shrunk by
          // dropped DLC/soundtracks, and `total` counts games only (verified live).
          ...(opts.gamesOnly ? { filters: { type_filters: { include_games: true } } } : {}),
          context: {
            language: opts.language ?? this.#l,
            country_code: opts.country ?? this.#country,
          },
          data_request: {
            include_platforms: true,
            include_all_purchase_options: true,
            include_extra_details: true,
          },
        }),
      },
      { hasCredentials: false },
    );
    return summarizeSearchSuggestions(res);
  }

  // Batch store card (price+discount, review %, compat, popular tags, release) for
  // a list of appids in one keyless call via the modern store-browse service. The
  // efficient way to price-, rating- and tag-check a known list (wishlist/library)
  // without N requests. Tag names come from a second, cached dictionary lookup.
  async getItems(
    appids: number[],
    country?: string,
    language?: string,
  ): Promise<Record<string, unknown>> {
    const l = language ?? this.#l;
    const input = {
      ids: appids.map((appid) => ({ appid })),
      context: { language: l, country_code: country ?? this.#country },
      data_request: storeCardDataRequest(15), // 15 tags: display-only (get_items doesn't tag-filter)
    };
    // get_items never filters by tags — a failed dictionary just means the
    // `tags` display field comes back empty, which resolveTags already handles.
    const { res, tagMap } = await this.#fetchWithTags<StoreItemsResponse>(
      "IStoreBrowseService/GetItems/v1/",
      { input_json: JSON.stringify(input) },
      l,
    );
    return summarizeItems(res, appids, tagMap);
  }

  // Steam charts (get_charts), all keyless: weekly top sellers and the weekly
  // Steam Deck most-played (names ride along on each rank's `item`), and the
  // most-played / live-concurrent top-100s, which
  // carry only appids — their names come from ONE batched GetItems call.
  // Cached under the shared TtlCache TTL (CACHE_TTL_MS), stale-on-error.
  async getCharts(chart: ChartName, opts: { limit: number }): Promise<Record<string, unknown>> {
    const { limit } = opts;
    if (chart === "top_sellers") {
      // The ranking itself is global (verified live: identical for US/JP/RU), so
      // no country parameter; the configured one only shapes the request context.
      const cc = this.#country;
      const res = await this.#cache.wrapStaleOnError(
        `charts:top_sellers:${cc}:${this.#l}:${limit}`,
        () =>
          this.#get<TopSellersResponse>(
            "IStoreTopSellersService/GetWeeklyTopSellers/v1/",
            {
              input_json: JSON.stringify({
                context: { country_code: cc, language: this.#l },
                page_count: limit,
              }),
            },
            { hasCredentials: false },
          ),
      );
      return summarizeTopSellers(res, limit);
    }
    if (chart === "most_played_deck") {
      // Period 1 is the only one Steam labels: its own chart page requests it and
      // reads "Top 100 played games on Steam Deck in the past week" (2 and 3 also
      // answer, but nothing says what they cover). Global like the others
      // (verified live: identical for US/JP/RU); names ride along on `item`.
      const cc = this.#country;
      const res = await this.#cache.wrapStaleOnError(
        `charts:most_played_deck:${cc}:${this.#l}:${limit}`,
        () =>
          this.#get<DeckMostPlayedResponse>(
            "ISteamChartsService/GetMostPlayedSteamDeckGames/v1/",
            {
              input_json: JSON.stringify({
                context: { country_code: cc, language: this.#l },
                data_request: {},
                top_played_period: 1,
                count: limit,
              }),
            },
            { hasCredentials: false },
          ),
      );
      return summarizeMostPlayedDeck(res, limit);
    }
    const concurrent = chart === "concurrent_players";
    const res = await this.#cache.wrapStaleOnError(`charts:${chart}`, () =>
      this.#get<MostPlayedResponse & ConcurrentPlayersResponse>(
        `ISteamChartsService/${concurrent ? "GetGamesByConcurrentPlayers" : "GetMostPlayedGames"}/v1/`,
        { input_json: "{}" },
        { hasCredentials: false },
      ),
    );
    const names = await this.#chartNames(chartAppids(res, limit));
    return concurrent
      ? summarizeConcurrentPlayers(res, limit, names)
      : summarizeMostPlayed(res, limit, names);
  }

  // Best-effort appid → name for the player charts: a failed or malformed lookup
  // leaves names null instead of failing the chart (HttpClient already logs the
  // underlying failure). Empty data_request keeps it ~1 KB per item.
  async #chartNames(appids: number[]): Promise<Map<number, string>> {
    if (appids.length === 0) return new Map();
    try {
      const res = await this.#get<StoreItemsResponse>(
        "IStoreBrowseService/GetItems/v1/",
        {
          input_json: JSON.stringify({
            ids: appids.map((appid) => ({ appid })),
            context: { language: this.#l, country_code: this.#country },
            data_request: {},
          }),
        },
        { hasCredentials: false },
      );
      return itemNames(res);
    } catch {
      return new Map();
    }
  }

  // The base-game purchase price of each appid, for correcting the Storefront
  // API's price_overview (see format/storefront.ts's overridePrice() for the
  // upstream bug this exists to work around). Deliberately different from
  // getItems(): no tag dictionary (nothing displays tags here) and an EMPTY
  // data_request, which already returns best_purchase_option and keeps the
  // payload ~1 KB per item instead of ~4.5 KB.
  //
  // Best-effort by contract: this only ever improves numbers the caller already
  // has, so a chunk that fails just leaves its appids on the Storefront price
  // rather than failing the whole tool call. HttpClient already logs the
  // underlying failure.
  //
  // `cache` is for getGame only, whose appdetails entry is itself cached:
  // get_prices and search_games fetch their Storefront rows fresh, and a cached
  // correction laid over a fresh row would hide a sale that just started.
  async getPurchasePrices(
    appids: number[],
    country?: string,
    language?: string,
    opts: { cache?: boolean } = {},
  ): Promise<PurchasePrices> {
    if (appids.length === 0) return {};
    const context = {
      language: language ?? this.#l,
      country_code: country ?? this.#country,
    };
    const chunks: number[][] = [];
    for (let i = 0; i < appids.length; i += PRICE_LOOKUP_CHUNK)
      chunks.push(appids.slice(i, i + PRICE_LOOKUP_CHUNK));
    // Shaped inside the load, so a payload that fails its schema rejects like
    // a failed request: it costs only this chunk's corrections, and with
    // `cache` it is never stored (only a resolved load is). Caching the shaped
    // map rather than the raw response also keeps the entry ~50 B, not ~1 KB.
    const load = async (chunk: number[]) =>
      summarizePurchasePrices(
        await this.#get<StoreItemsResponse>(
          "IStoreBrowseService/GetItems/v1/",
          {
            input_json: JSON.stringify({
              ids: chunk.map((appid) => ({ appid })),
              context,
              data_request: {},
            }),
          },
          { hasCredentials: false },
        ),
      );
    // Stale-on-error so that during an outage getGame's stale appdetails entry
    // is still served WITH its correction, not with the raw Storefront price.
    // A failure is never cached, so it's retried on the next call.
    const settled = await Promise.allSettled(
      chunks.map((chunk) =>
        opts.cache
          ? this.#cache.wrapStaleOnError(
              `purchase:${context.country_code}:${context.language}:${chunk.join(",")}`,
              () => load(chunk),
            )
          : load(chunk),
      ),
    );
    // Never rejects: the outer Promise.all in StorefrontClient.getPrices/getGame
    // would otherwise turn an enrichment's failure into a failed tool call.
    const merged: PurchasePrices = {};
    for (const r of settled) if (r.status === "fulfilled") Object.assign(merged, r.value);
    return merged;
  }

  // Personalized recommendations: derive weighted tag preferences from a
  // sample of the player's most-played owned games, then rank a broad,
  // popularity-sorted catalog page by overlap with those weights, excluding
  // anything already owned. `ownedGames` must be the player's FULL library
  // (correct exclusion needs all of it) — only the top FAVORITE_TAG_SAMPLE_SIZE
  // by playtime are actually fetched to derive tags.
  async getRecommendedGames(
    ownedGames: { appid: number; playtimeMinutes: number }[],
    opts: {
      count?: number;
      country?: string;
      language?: string;
      excludeTags?: string[];
      minDiscount?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (ownedGames.length === 0) {
      return notFound("This player's library has no games to base recommendations on.");
    }
    const l = opts.language ?? this.#l;
    const cc = opts.country ?? this.#country;
    // None of the three requests depends on another's answer, so they run
    // concurrently. They're still awaited in the original order, so a missing
    // tag dictionary or an empty favorite-tag set wins over a failed sample or
    // pool request exactly as before; the no-op catches only keep a request
    // nobody awaits (after an early throw/return) from becoming an unhandled
    // rejection.
    const tagMapPromise = this.#tagNames(l);
    const sample = ownedGames
      .slice()
      .sort((a, b) => b.playtimeMinutes - a.playtimeMinutes)
      .slice(0, FAVORITE_TAG_SAMPLE_SIZE);
    const samplePromise = this.#get<StoreItemsResponse>(
      "IStoreBrowseService/GetItems/v1/",
      {
        input_json: JSON.stringify({
          ids: sample.map((g) => ({ appid: g.appid })),
          context: { language: l, country_code: cc },
          data_request: storeCardDataRequest(20),
        }),
      },
      { hasCredentials: false },
    );
    // The tool schema's own min(1).max(25) already bounds this — no need to
    // re-clamp here, just fall back for direct (non-tool) callers.
    const count = opts.count ?? 10;
    // Same server-side price filter #queryCatalog uses for discover_games — cuts
    // the candidate pool down to matching deals instead of scoring 150 items and
    // discarding most of them locally for a "good discounts only" request.
    const filters: Record<string, unknown> = {};
    if (typeof opts.minDiscount === "number")
      filters.price_filters = { min_discount_percent: opts.minDiscount };
    const poolPromise = this.#get<StoreQueryResponse>(
      "IStoreQueryService/Query/v1/",
      {
        input_json: JSON.stringify({
          query: { start: 0, count: RECOMMENDATION_POOL_SIZE, sort: 10, filters },
          context: { language: l, country_code: cc, steam_realm: 1 },
          data_request: storeCardDataRequest(20),
        }),
      },
      { hasCredentials: false },
    );
    samplePromise.catch(() => {});
    poolPromise.catch(() => {});
    const tagMap = await tagMapPromise;
    if (tagMap === null) {
      // Same "fail loudly, don't silently degrade" rule as
      // #requireTagMapIfFiltering — recommendations are meaningless without it.
      throw new ApiError({
        code: "unknown",
        message:
          "could not fetch Steam's tag dictionary right now, so recommendations can't be " +
          "computed. Retry shortly.",
        retryable: true,
      });
    }

    const sampleRes = await samplePromise;
    const tagWeights = computeFavoriteTagWeights(
      sampleRes.response?.store_items ?? [],
      new Map(sample.map((g) => [g.appid, g.playtimeMinutes])),
      tagMap,
    );
    if (tagWeights.size === 0) {
      return notFound("Not enough played games with resolvable tags to build recommendations.");
    }
    const basedOnTags = [...tagWeights.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, BASED_ON_TAGS_LIMIT)
      .map(([tag]) => tag);

    const poolRes = await poolPromise;
    const ownedAppids = new Set(ownedGames.map((g) => g.appid));
    return summarizeRecommendations(
      poolRes.response?.store_items ?? [],
      tagWeights,
      ownedAppids,
      tagMap,
      count,
      basedOnTags,
      opts.excludeTags,
      opts.minDiscount,
    );
  }

  // Shared catalog discovery over the keyless store query backend (discoverGames
  // is a thin preset over this). The Query API can't filter/sort on reviews,
  // Deck or release date, so those are applied in
  // summarizeDiscover over the returned page — which is why we sort by
  // popularity (sort:10): without a sort the page is appid-ordered and fills
  // with obscure, Deck-untested shovelware, making the post-filters return
  // nothing useful. Popularity puts real games (with Deck ratings + review
  // counts) into the window.
  async #queryCatalog(
    p: {
      minDiscount?: number;
      releasedOnly?: boolean;
      count?: number;
      start?: number;
      minReview?: number;
      minReviews?: number;
      platform?: "windows" | "mac" | "linux";
      releasedAfter?: number;
      tags?: string[];
      country?: string;
      language?: string;
    } & CompatFilters,
  ): Promise<Record<string, unknown>> {
    const l = p.language ?? this.#l;
    const filters: Record<string, unknown> = {};
    if (typeof p.minDiscount === "number")
      filters.price_filters = { min_discount_percent: p.minDiscount };
    if (p.releasedOnly) filters.released_only = true;
    const input = {
      query: { start: p.start ?? 0, count: p.count ?? 50, sort: 10, filters },
      context: {
        language: l,
        country_code: p.country ?? this.#country,
        steam_realm: 1,
      },
      data_request: storeCardDataRequest(20), // 20 tags: full set so tag filtering isn't capped
    };
    // Fetch the tag dictionary alongside the page (cached, so ~free after the
    // first call) — every card surfaces resolved tag names.
    const { res, tagMap } = await this.#fetchWithTags<StoreQueryResponse>(
      "IStoreQueryService/Query/v1/",
      { input_json: JSON.stringify(input) },
      l,
      p.tags,
    );
    return summarizeDiscover(res, {
      // Passed through so summarizeDiscover's storeItemFilter re-checks the
      // discount client-side: Steam's server-side min_discount_percent filter
      // silently no-ops at exactly 100 (returns the full catalog), so without
      // this backstop min_discount:100 would leak full-price games.
      minDiscount: p.minDiscount,
      minReview: p.minReview,
      minReviews: p.minReviews,
      steamDeck: p.steamDeck,
      steamOs: p.steamOs,
      steamMachine: p.steamMachine,
      steamFrame: p.steamFrame,
      platform: p.platform,
      releasedAfter: p.releasedAfter,
      tags: p.tags,
      tagMap,
    });
  }

  // Catalog-wide game discovery: browse by discount, recency, hardware
  // compatibility (Steam Deck / SteamOS / Steam Machine / Steam Frame) and review
  // quality, in any combination. Every filter is optional — pass minDiscount for
  // "on sale", releasedAfter for "new", steamDeck/steamOs/steamMachine/steamFrame
  // for "runs on X", or mix them. released_only is set only when a recency cutoff
  // is given, so a pure deal query still surfaces pre-purchase discounts.
  async discoverGames(
    p: {
      releasedAfter?: number;
      minDiscount?: number;
      count?: number;
      start?: number;
      minReview?: number;
      minReviews?: number;
      platform?: "windows" | "mac" | "linux";
      tags?: string[];
      country?: string;
      language?: string;
    } & CompatFilters,
  ): Promise<Record<string, unknown>> {
    return this.#queryCatalog({ ...p, releasedOnly: p.releasedAfter !== undefined });
  }

  // Enriched wishlist: GetWishlistSortedFiltered embeds a full store card per
  // entry, so "my wishlist with prices / deals" is one keyless call instead of
  // getWishlist + getItems. Also fetches the (cached) tag dictionary to resolve
  // tag names. onSaleOnly keeps just the discounted entries, ranked by discount.
  async getWishlistDetailed(
    steamid: string,
    opts: {
      onSaleOnly?: boolean;
      tags?: string[];
      minReview?: number;
      minDiscount?: number;
      platform?: "windows" | "mac" | "linux";
      country?: string;
      language?: string;
    } & CompatFilters = {},
  ): Promise<Record<string, unknown>> {
    const l = opts.language ?? this.#l;
    const input = {
      steamid,
      context: { language: l, country_code: opts.country ?? this.#country, steam_realm: 1 },
      data_request: storeCardDataRequest(20), // 20 tags: full set so tag filtering isn't capped
      sort: 0,
    };
    const filters = {
      onSaleOnly: opts.onSaleOnly,
      tags: opts.tags,
      minReview: opts.minReview,
      minDiscount: opts.minDiscount,
      platform: opts.platform,
      steamDeck: opts.steamDeck,
      steamOs: opts.steamOs,
      steamMachine: opts.steamMachine,
      steamFrame: opts.steamFrame,
    };
    // Some malformed/out-of-range steamids (e.g. accountid 0) make Steam answer
    // a raw HTTP 400 here instead of its usual empty-wishlist response — treat
    // it the same way rather than leaking the raw upstream body to the agent.
    const { res, tagMap } = await withFallbackOn(
      "bad_request",
      () =>
        this.#fetchWithTags<WishlistDetailedResponse>(
          "IWishlistService/GetWishlistSortedFiltered/v1/",
          { input_json: JSON.stringify(input) },
          l,
          opts.tags,
        ),
      { res: {} as WishlistDetailedResponse, tagMap: undefined },
    );
    return summarizeWishlistDetailed(res, tagMap, filters);
  }
}
