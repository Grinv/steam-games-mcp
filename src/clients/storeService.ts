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
import { ApiError } from "../lib/errors.js";
import type { TtlCache } from "../lib/cache.js";
import {
  summarizeDiscover,
  summarizeItems,
  summarizeTagList,
  summarizeWishlistDetailed,
  type CompatFilters,
  type GetTagListResponse,
  type StoreItemsResponse,
  type StoreQueryResponse,
  type TagMap,
  type WishlistDetailedResponse,
} from "../format/store.js";

type Query = Record<string, string | number | boolean | undefined>;
// The parent's authenticated `#get` (bakes in the key, sent when present per
// AGENTS.md's keyless caveat — these endpoints answer without one too).
type Get = <T>(path: string, query: Query) => Promise<T>;

// The include_* flags every store-service card call needs (basic info, reviews,
// release, native platforms + compat, popular tags). tagCount varies: fewer for
// display-only (get_items), more when tags are also filtered (discover/wishlist).
const storeCardDataRequest = (tagCount: number) => ({
  include_basic_info: true,
  include_reviews: true,
  include_release: true,
  include_platforms: true,
  include_tag_count: tagCount,
});

export class StoreServiceClient {
  readonly #get: Get;
  readonly #cache: TtlCache<Record<string, unknown>>;
  readonly #l: string;
  readonly #country: string;

  constructor(opts: {
    get: Get;
    cache: TtlCache<Record<string, unknown>>;
    language: string;
    country: string;
  }) {
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
      const map = await this.#cache.wrapStaleOnError(`tags:${language}`, async () => {
        const res = await this.#get<GetTagListResponse>("IStoreService/GetTagList/v1/", {
          language,
        });
        return summarizeTagList(res) as Record<string, unknown>;
      });
      return map as TagMap;
    } catch {
      return null;
    }
  }

  // Throws when a tags filter was requested but the tag dictionary is
  // unavailable — never silently treats that as "nothing matched".
  #requireTagMapIfFiltering(tags: string[] | undefined, tagMap: TagMap | null): TagMap | undefined {
    if (tagMap !== null) return tagMap;
    if (!tags?.length) return undefined;
    // "unknown" is the one ApiErrorCode whose mapped message (lib/result.ts)
    // includes our own text verbatim — the other codes render a fixed,
    // generic sentence per code and would swallow this explanation.
    throw new ApiError({
      code: "unknown",
      message:
        "could not fetch Steam's tag dictionary right now, so the `tags` filter can't be " +
        "reliably applied. Retry, or drop `tags` to see unfiltered results.",
      retryable: true,
    });
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
    const [res, tagMap] = await Promise.all([
      this.#get<StoreItemsResponse>("IStoreBrowseService/GetItems/v1/", {
        input_json: JSON.stringify(input),
      }),
      this.#tagNames(l),
    ]);
    // get_items never filters by tags — a failed dictionary just means the
    // `tags` display field comes back empty, which resolveTags already handles.
    return summarizeItems(res, appids, tagMap ?? undefined);
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
    const [res, tagMap] = await Promise.all([
      this.#get<StoreQueryResponse>("IStoreQueryService/Query/v1/", {
        input_json: JSON.stringify(input),
      }),
      this.#tagNames(l),
    ]);
    return summarizeDiscover(res, {
      minReview: p.minReview,
      minReviews: p.minReviews,
      steamDeck: p.steamDeck,
      steamOs: p.steamOs,
      steamMachine: p.steamMachine,
      steamFrame: p.steamFrame,
      platform: p.platform,
      releasedAfter: p.releasedAfter,
      tags: p.tags,
      tagMap: this.#requireTagMapIfFiltering(p.tags, tagMap),
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
    const [res, tagMap] = await Promise.all([
      this.#get<WishlistDetailedResponse>("IWishlistService/GetWishlistSortedFiltered/v1/", {
        input_json: JSON.stringify(input),
      }),
      this.#tagNames(l),
    ]);
    const safeTagMap = this.#requireTagMapIfFiltering(opts.tags, tagMap);
    return summarizeWishlistDetailed(res, safeTagMap, {
      onSaleOnly: opts.onSaleOnly,
      tags: opts.tags,
      minReview: opts.minReview,
      minDiscount: opts.minDiscount,
      platform: opts.platform,
      steamDeck: opts.steamDeck,
      steamOs: opts.steamOs,
      steamMachine: opts.steamMachine,
      steamFrame: opts.steamFrame,
    });
  }
}
