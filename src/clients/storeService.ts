// Client for Steam's undocumented, keyless "store service" APIs
// (IStoreBrowseService/GetItems, IStoreQueryService/Query, IStoreService/GetTagList,
// IWishlistService/GetWishlistSortedFiltered) — the modern store-card backend
// behind get_items, discover_games and get_wishlist's include_details. Split out
// of SteamWebClient (clients/web.ts) to mirror format/'s web.ts/store.ts split:
// this class owns everything that formats through format/store.ts's shared card
// builder. The basic (light) get_wishlist and get_followed_games stay on
// SteamWebClient, matching format/web.ts's ownership of their formatters.
//
// Shares the parent's HttpClient (via the `call` passed in) rather than owning
// its own — both clients hit the same api.steampowered.com host and must honor
// one rate limiter and one cache, not one each.
import { ApiError } from "../lib/errors.ts";
import { hasAppid, isRecord, usableRows } from "../format/shared.ts";
import type { Answered, CallOptions, Endpoint, Query } from "../lib/endpoint.ts";
import { Steam } from "./endpoints.ts";
import { noteDegraded, optional, optionalParts, orFailure } from "../lib/call.ts";
import {
  computeFavoriteTagWeights,
  noGamesToRecommendFrom,
  noTasteToRecommendFrom,
  summarizeDiscover,
  summarizeItems,
  summarizePurchasePrices,
  summarizeRecommendations,
  summarizeSearchSuggestions,
  summarizeWishlistDetailed,
  type PurchasePrices,
  WISHLIST_DETAIL_MAX,
} from "../format/store.ts";
import {
  summarizeConcurrentPlayers,
  summarizeMostPlayed,
  summarizeMostPlayedDeck,
  summarizeTopSellers,
} from "../format/charts.ts";
import type { ChartName } from "../format/charts.ts";
import {
  summarizeTagList,
  tagNames,
  unsettledItems,
  type CompatFilters,
  type TagMap,
  TAG_LIMIT,
} from "../format/storeCard.ts";

// The parent's `#call` (bakes in the key, sent when present per AGENTS.md's
// keyless caveat — these endpoints answer without one too).
type Call = <T, A extends string>(
  ep: Endpoint<T, A>,
  query: Query,
  opts?: CallOptions,
) => Promise<Answered<T, A>>;

// Cards Steam's answer doesn't settle (shownHere undefined) are left out of
// a list or marked unknown, and said here, never dropped without a word.
function noteUnsettled(n: number): void {
  if (!n) return;
  noteDegraded(
    `Store data of ${n} games`,
    new ApiError({
      code: "bad_response",
      message: `${n} store items didn't say whether they're shown here`,
      detail: "Steam's answer didn't say whether they're shown in this country.",
      retryable: true,
    }),
  );
}

// The include_* flags every store-service card call needs (reviews, release,
// native platforms + compat, popular tags). Not include_basic_info: no card
// field reads it (name and is_free come with every item), and it was ~14% of
// the payload — verified live that items are otherwise identical without it. TAG_LIMIT tags: every card
// and the recommendation scoring read only that many (storeCard.ts), Steam
// returns the most-weighted ones first (verified live), and tag FILTERING runs
// server-side, so a longer list was only ever discarded.
// Exported for scripts/check-api.ts, which checks the fields cards read off it.
export const storeCardDataRequest = () => ({
  include_reviews: true,
  include_release: true,
  include_platforms: true,
  include_tag_count: TAG_LIMIT,
  // Steam's best_purchase_option is routinely a bundle of this app AND another
  // game, so every card needs the app's own package alongside it — see
  // format/storeCard.ts's ownPurchaseOption() for why this is asked up front
  // rather than fetched in a follow-up.
  include_all_purchase_options: true,
});

// ---- server-side catalog filters (IStoreQueryService/Query) -----------------
//
// Query takes CStoreQueryFilters and applies them across the WHOLE catalog, so
// a filtered page holds the most popular games that match rather than the
// matches that happen to sit inside the top `count` (verified live 2026-10-20:
// Roguelike + Indie + Deck Verified + Very Positive found 155 games
// server-side, 0 inside a 50-game popularity window). Every value below was
// verified live. Tags, the release date (release_date_filter compares
// steam_release_date with >=, exact to the second — verified live), games-only
// and one compat dimension are exact, so nothing re-checks them; the review
// bucket and the discount are supersets that summarizeDiscover re-checks
// exactly, along with the filters Steam has no form for.

// compatibility_filter.device per compat dimension. There is no device for
// SteamOS in general, and Steam takes ONE compatibility_filter, so a second
// requested dimension is left to the client-side pass.
const COMPAT_DEVICE = [
  ["steamDeck", 1],
  ["steamFrame", 2],
  ["steamMachine", 3],
] as const satisfies readonly [keyof CompatFilters, number][];
// "playable" here means playable OR verified, like COMPAT_MIN in storeCard.ts.
const COMPAT_CATEGORIES = { verified: [3], playable: [2, 3] } as const;

// The lowest EUserReviewScore bucket that can still hold a game at `pct`
// positive: Positive (7) and up are all 80%+, Mostly Positive (6) 70-79%,
// Mixed (5) 40-69%, Mostly Negative (4) 20-39%. Taken one point below the
// threshold because Steam buckets the exact ratio while percent_positive is
// rounded: a 79.6% game reads 80 but sits in Mostly Positive, and must reach
// the exact re-check. Only games with a Steam rating (10+ reviews) carry a
// bucket at all, so min_review leaves out unrated games.
function reviewScoreFloor(threshold: number): number {
  const pct = threshold - 1;
  if (pct >= 80) return 7;
  if (pct >= 70) return 6;
  if (pct >= 40) return 5;
  if (pct >= 20) return 4;
  return 1;
}

// Without case, as each language writes it in capitals: lower, upper, lower,
// so German ß and ẞ are ss and Turkish ı is i (toLowerCase alone keeps them
// apart from SS and I); minus the dot Turkish İ lowercases with; Greek
// without its accents (Greek capitals drop them: ΣΤΡΑΤΗΓΙΚΗ is Στρατηγική)
// and with one sigma (final ς depends on where a word ends). Checked live on
// all 31 tag dictionaries, each name typed in its language's capitals, in
// lowercase and with ẞ: every one found, no two merged.
function caseless(s: string): string {
  return s
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize("NFD")
    .replace(/(\p{Script=Greek})\p{M}+/gu, "$1")
    .replace(/i\u0307/g, "i")
    .normalize("NFC")
    .replace(/ς/g, "σ");
}

// A title as matched by name: only its letters and digits count — symbols
// (™, ®) dropped, compatibility forms unfolded (², full-width letters), and
// accents folded: Latin and Greek marks, and Cyrillic ё to е (the one way
// Russian is commonly typed without its mark): "half life" is Half-Life,
// "dont starve" Don't Starve, "mirrors edge" Mirror's Edge™, "pokemon"
// Pokémon, "portal 2" Portal². Other marks are part of the letter — Cyrillic
// й isn't и, Ukrainian ї isn't і, Japanese ガ isn't カ — so they're kept (NFC).
function titleKey(s: string): string {
  const folded = s
    // A symbol with its presentation selector or keycap (❤️, 1️⃣), not just the symbol.
    .replace(/\p{S}[\uFE00-\uFE0F\u20E3]*|[\uFE00-\uFE0F\u20E3]/gu, "")
    .normalize("NFKD")
    .replace(/([\p{Script=Latin}\p{Script=Greek}])\p{M}+/gu, "$1")
    .replace(/([еЕ])\u0308/g, "$1")
    .normalize("NFC");
  return caseless(folded).replace(/[^\p{L}\p{N}\p{M}]/gu, "");
}

// Tag names → each name's tagids, case-insensitively. A name isn't unique: in
// 10 of Steam's 31 languages two tags share one (French "combat" is 1743 and
// 3993, Dutch "snooker" 4852 and 363767; every dictionary checked live
// 2026-11-19), so a name means any of its tags. Steam would take a name it
// doesn't have without a word (it matches or excludes nothing), and the
// dictionary is in hand, so such a name is refused here, naming it.
function tagIdsFor(names: string[], tagMap: TagMap, language: string): number[][] {
  // caseless also makes an accented name typed decomposed (some macOS input)
  // the same name.
  const key = caseless;
  const byName = new Map<string, number[]>();
  for (const [id, n] of Object.entries(tagMap)) {
    const k = key(n);
    byName.set(k, [...(byName.get(k) ?? []), Number(id)]);
  }
  const idsOf = (name: string) => byName.get(key(name)) ?? [];
  const unknown = names.filter((n) => idsOf(n).length === 0);
  if (unknown.length) {
    throw new ApiError({
      code: "bad_request",
      message: `not Steam tags in ${language}: ${unknown.join(", ")}`,
      detail:
        `Not a Steam tag in ${language}: ${unknown.map((n) => `"${n}"`).join(", ")}. Tag names ` +
        "are Steam's own, in the call's language; get_items shows a game's tags.",
    });
  }
  return names.map(idsOf);
}

// Query's price_filters for a discount floor. Steam ignores min_discount_percent
// at exactly 100 and answers with the whole catalog (verified live 2026-11-05:
// 90 → 421 matches, 99 → 0, 100 → 198452), so 100 is sent as 99, a superset
// that the client-side re-check narrows to 100. GetWishlistSortedFiltered's own
// filter honors 100 and needs no such mapping.
function queryDiscountFilter(minDiscount: number): Record<string, unknown> {
  return { min_discount_percent: Math.min(minDiscount, 99) };
}

function catalogFilters(
  p: {
    minDiscount?: number;
    releasedOnly?: boolean;
    releasedAfter?: number;
    minReview?: number;
  } & CompatFilters,
  tagIds: number[][] | undefined,
): Record<string, unknown> {
  const filters: Record<string, unknown> = { type_filters: { include_games: true } };
  if (typeof p.minDiscount === "number") filters.price_filters = queryDiscountFilter(p.minDiscount);
  if (p.releasedOnly) filters.released_only = true;
  // release_date_type 1 = released on/after start_date.
  if (p.releasedAfter !== undefined)
    filters.release_date_filter = { release_date_type: 1, start_date: p.releasedAfter };
  if (typeof p.minReview === "number" && p.minReview > 0)
    filters.review_score_filter = { min_score: reviewScoreFloor(p.minReview) };
  const compat = COMPAT_DEVICE.find(([key]) => p[key] !== undefined);
  if (compat)
    filters.compatibility_filter = {
      device: compat[1],
      categories: COMPAT_CATEGORIES[p[compat[0]]!],
    };
  // One group per tag name: groups are ANDed (each name required), a group's
  // own tagids are ORed (verified live) — a name's every tag.
  if (tagIds?.length) filters.tagids_must_match = tagIds.map((ids) => ({ tagids: ids }));
  return filters;
}

// GetWishlistSortedFiltered lists EVERY matching entry but attaches a store
// card only to the first `page_size` (default 100) — so without it a >100-item
// wishlist silently lost its tail's prices, reviews and tags (verified live:
// 180 entries, 100 enriched by default, all 180 at page_size 200). A filter
// only Steam applies needs cards for just the displayed page; one we re-check
// ourselves needs them for every match, up to this bound (a wishlist can hold
// tens of thousands of entries at ~4.5 KB per card).
const WISHLIST_CHECK_MAX = 1000;

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

/** get_recommended_games' dictionary and its exclude_tags ids (every tag of
 *  each name), from recommendationTags. */
export interface RecommendationTags {
  tagMap: TagMap;
  excludeIds: number[];
}

const priceCheck = (n: number) =>
  `Price check of ${n} appids against the store's purchase options ` +
  "(the price shown may be an upgrade or bundle SKU's, not the game's)";

export class StoreServiceClient {
  readonly #call: Call;
  readonly #l: string;
  readonly #country: string;

  constructor(opts: { call: Call; language: string; country: string }) {
    this.#call = opts.call;
    this.#l = opts.language;
    this.#country = opts.country;
  }

  // Tag dictionary (tagid → localized name) from IStoreService/GetTagList
  // (keyless). Store items carry only numeric tagids; this resolves them to the
  // readable tag names surfaced on each card. Cached per language and tiny
  // (~450 entries, stable), so one fetch serves many cards.
  // Returns the upstream failure (rather than throwing it) — callers that only
  // DISPLAY tags can degrade gracefully (empty tags list); callers that FILTER
  // by tags must fail loudly instead of silently returning zero matches (an
  // empty dictionary would make every tag filter reject every item,
  // indistinguishable from "no games matched"), via #tagsUnavailable.
  async #tagNames(language: string): Promise<TagMap | ApiError> {
    // Not optional(): the filter path must fail loudly (#tagsUnavailable),
    // the display path degrades — so the failure is handed back to decide.
    const res = await orFailure(this.#call(Steam.GetTagList, { language }, { cache: true }));
    return res instanceof ApiError ? res : summarizeTagList(res);
  }

  // A tag dictionary failure, explained for a caller that can't go on without
  // it. Keeps the upstream failure's own code, status and retryability (a 429
  // still reads as a rate limit), adding only what it means here.
  #tagsUnavailable(cause: ApiError, consequence: string, language: string): ApiError {
    return new ApiError({
      code: cause.code,
      status: cause.status,
      retryable: cause.retryable,
      message: `tag dictionary unavailable (${language})`,
      // The cause's own detail, if any, follows ours; a 429/5xx carries none
      // and gets the code's "retry" advice instead.
      detail: [`Could not fetch Steam's tag dictionary, so ${consequence}.`, cause.detail]
        .filter(Boolean)
        .join(" "),
      cause,
    });
  }

  // get_recommended_games' dictionary, read once and alongside the library
  // (clients/web.ts). An unknown exclude_tags name is the input's fault, so it
  // throws, before any verdict about the library; the dictionary failing is
  // Steam's, returned so the library's own verdict (hidden, empty) still
  // comes first — recommendations can't be computed without it either way.
  async recommendationTags(
    excludeTags: string[] | undefined,
    language?: string,
  ): Promise<RecommendationTags | ApiError> {
    const l = language ?? this.#l;
    const tagMap = await this.#tagNames(l);
    if (tagMap instanceof ApiError) {
      return this.#tagsUnavailable(tagMap, "recommendations can't be computed", l);
    }
    return { tagMap, excludeIds: tagIdsFor(excludeTags ?? [], tagMap, l).flat() };
  }

  // Tag names → ids for a server-side tag filter, which needs the dictionary
  // BEFORE the query (cached per language, so usually free). tagIds is
  // undefined with no tags.
  async #resolveTagFilter(
    tags: string[] | undefined,
    language: string,
  ): Promise<{ tagMap: TagMap | undefined; tagIds: number[][] | undefined }> {
    if (!tags?.length) return { tagMap: undefined, tagIds: undefined };
    const tagMap = this.#requireTagMapIfFiltering(tags, await this.#tagNames(language), language)!;
    return { tagMap, tagIds: tagIdsFor(tags, tagMap, language) };
  }

  // Throws when a tags filter was requested but the tag dictionary is
  // unavailable — never silently treats that as "nothing matched".
  #requireTagMapIfFiltering(
    tags: string[] | undefined,
    tagMap: TagMap | ApiError,
    language: string,
  ): TagMap | undefined {
    if (!(tagMap instanceof ApiError)) return tagMap;
    if (tags?.length) {
      throw this.#tagsUnavailable(
        tagMap,
        "the `tags` filter can't be reliably applied (drop `tags` to see unfiltered results)",
        language,
      );
    }
    noteDegraded("Game tags", tagMap);
    return undefined;
  }

  // Shared shape behind getItems/#queryCatalog/getWishlistDetailed: fetch the
  // store-service page alongside the (cached) tag dictionary in parallel; the
  // tags are display-only here, so a missing dictionary is a noted gap. A
  // caller that filtered by tags already read the dictionary (and failed
  // loudly without it): it passes that one in, so there's one read per call.
  async #fetchWithTags<T, A extends string>(
    ep: Endpoint<T, A>,
    query: Query,
    language: string,
    filterTagMap?: TagMap,
  ): Promise<{ res: Answered<T, A>; tagMap: TagMap | undefined }> {
    if (filterTagMap) return { res: await this.#call(ep, query), tagMap: filterTagMap };
    const [res, tagMap] = await Promise.all([this.#call(ep, query), this.#tagNames(language)]);
    return { res, tagMap: this.#requireTagMapIfFiltering(undefined, tagMap, language) };
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
    opts: {
      country?: string;
      language?: string;
      limit?: number;
      gamesOnly?: boolean;
      // Names only (no prices/metascore/platforms): for the prompt's per-keystroke
      // title completions, which read nothing else.
      namesOnly?: boolean;
    } = {},
  ): Promise<Record<string, unknown>> {
    const res = await this.#call(Steam.SearchSuggestions, {
      input_json: JSON.stringify({
        search_term: term,
        max_results: opts.limit ?? 10,
        // Games only unless told otherwise (a title search is nearly always for
        // the game, and DLC/soundtracks otherwise crowd it out). Server-side, so
        // `limit` is filled with games rather than shrunk by dropped items, and
        // `total` counts games only (verified live).
        ...((opts.gamesOnly ?? true) ? { filters: { type_filters: { include_games: true } } } : {}),
        context: {
          language: opts.language ?? this.#l,
          country_code: opts.country ?? this.#country,
        },
        data_request: opts.namesOnly
          ? {}
          : {
              include_platforms: true,
              include_all_purchase_options: true,
              include_extra_details: true,
            },
      }),
    });
    return summarizeSearchSuggestions(res);
  }

  // get_game's name → appid: the item named exactly that (ignoring case and
  // punctuation), else the search's top match. Steam ranks by popularity, not
  // by name: "portal" puts Portal 2 above Portal, "doom" DOOM: The Dark Ages
  // above DOOM (seen live 2026-11-19), so the top hit alone answered for the
  // wrong game. Every item type, unlike search_games' games-only default — a
  // DLC looked up by its own name must resolve to the DLC (verified live:
  // games-only turned "shadow of the erdtree" into Shadow of the Tomb Raider).
  // Returns null when nothing matches.
  async resolveAppId(term: string, country?: string, language?: string): Promise<number | null> {
    const res = await this.#call(Steam.SearchSuggestions, {
      input_json: JSON.stringify({
        search_term: term,
        max_results: 10,
        context: { language: language ?? this.#l, country_code: country ?? this.#country },
        data_request: {},
      }),
    });
    // "No game" is Steam's own count (0, recorded: no-match); a count beside
    // nothing usable fails the body rule (searchSuggestionsRule).
    if (res.response.metadata.total_matching_records === 0) return null;
    const items = usableRows(
      res.response.store_items,
      hasAppid,
      "search results",
      "SearchSuggestions",
      "appid",
    );
    const wanted = titleKey(term);
    const exact = wanted ? items.find((it) => titleKey(it.name ?? "") === wanted) : undefined;
    return (exact ?? items[0])?.appid ?? null;
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
      data_request: storeCardDataRequest(),
    };
    // get_items never filters by tags — a failed dictionary just means the
    // `tags` display field comes back empty, which resolveTags already handles.
    const { res, tagMap } = await this.#fetchWithTags(
      Steam.GetItems,
      { input_json: JSON.stringify(input) },
      l,
    );
    const out = summarizeItems(res, appids, tagMap);
    // An item that doesn't say whether it's shown (decided from Steam's items;
    // a row with no usable item is noted where it's dropped).
    noteUnsettled(unsettledItems(res.response?.store_items ?? []));
    return out;
  }

  // Steam charts (get_charts), all keyless, names riding along on each rank's
  // `item`: weekly top sellers, the weekly Steam Deck most-played, and the
  // most-played / live-concurrent top-100s. Cached for CACHE_TTL_MS, with a
  // stale copy served while Steam is down (lib/http.ts).
  async getCharts(
    chart: ChartName,
    opts: { limit: number; country?: string; weekOf?: number },
  ): Promise<Record<string, unknown>> {
    const { limit } = opts;
    if (chart === "top_sellers") {
      // Global unless the request's TOP-LEVEL country_code is set: that gives
      // the country's own chart (verified live: DE, BR and JP each differ from
      // the global order), while context.country_code alone changes nothing —
      // which is how this was once mistaken for a global-only ranking.
      // start_date is snapped by Steam to the week containing it (weeks start
      // Tuesday 00:00 UTC; history reaches back 10+ years, verified live).
      const { country, weekOf } = opts;
      const res = await this.#call(
        Steam.GetWeeklyTopSellers,
        {
          input_json: JSON.stringify({
            ...(country ? { country_code: country } : {}),
            context: { country_code: country ?? this.#country, language: this.#l },
            ...(weekOf !== undefined ? { start_date: weekOf } : {}),
            page_count: limit,
          }),
        },
        { cache: true },
      );
      return summarizeTopSellers(res, limit);
    }
    if (chart === "most_played_deck") {
      // Period 1 is the only one Steam labels: its own chart page requests it and
      // reads "Top 100 played games on Steam Deck in the past week" (2 and 3 also
      // answer, but nothing says what they cover). Global like the others
      // (verified live: identical for US/JP/RU), so no country in the cache key;
      // names ride along on `item`, localized, hence the language. `limit` goes
      // upstream as `count`, like top_sellers' page_count: every entry carries a
      // full store item, so count 100 is ~80 KB vs ~8 KB for 10 (measured live).
      const res = await this.#call(
        Steam.GetMostPlayedSteamDeckGames,
        {
          input_json: JSON.stringify({
            context: { country_code: this.#country, language: this.#l },
            data_request: {},
            top_played_period: 1,
            count: limit,
          }),
        },
        { cache: true },
      );
      return summarizeMostPlayedDeck(res, limit);
    }
    // Neither service takes a count (verified live: count/max_results/page_count/
    // limit and friends are all ignored, 100 ranks come back), so the full chart
    // is fetched with names inlined via data_request (~67 KB) and cached once
    // per language, serving every `limit` from that one entry — cheaper than
    // the separate, uncached GetItems name lookup per call it replaces.
    const concurrent = chart === "concurrent_players";
    const query = {
      input_json: JSON.stringify({
        context: { country_code: this.#country, language: this.#l },
        data_request: {},
      }),
    };
    return concurrent
      ? summarizeConcurrentPlayers(
          await this.#call(Steam.GetGamesByConcurrentPlayers, query, { cache: true }),
          limit,
        )
      : summarizeMostPlayed(
          await this.#call(Steam.GetMostPlayedGames, query, { cache: true }),
          limit,
        );
  }

  // The base-game purchase price of each appid, for correcting the Storefront
  // API's price_overview (see format/storefront.ts's overridePrice() for the
  // upstream bug this exists to work around). Deliberately different from
  // getItems(): no tag dictionary (nothing displays tags here), and the
  // data_request asks only for every purchase option. best_purchase_option
  // alone is often a bundle, so the app's own package has to be picked from
  // the full list (format/store.ts's summarizePurchasePrices()).
  //
  // Best-effort by contract: this only ever improves numbers the caller already
  // has, so a chunk that fails just leaves its appids on the Storefront price
  // rather than failing the whole tool call — a gap noted for the model
  // (optionalParts) and logged by tools/guard.ts.
  //
  // Uncached: get_prices and search_games fetch their Storefront rows fresh,
  // and a cached correction laid over a fresh row would hide a sale that just
  // started. get_game's cached one is getGamePurchasePrice, below.
  async getPurchasePrices(
    appids: number[],
    country?: string,
    language?: string,
  ): Promise<PurchasePrices> {
    if (appids.length === 0) return {};
    const context = {
      language: language ?? this.#l,
      country_code: country ?? this.#country,
    };
    const chunks: number[][] = [];
    for (let i = 0; i < appids.length; i += PRICE_LOOKUP_CHUNK)
      chunks.push(appids.slice(i, i + PRICE_LOOKUP_CHUNK));
    // A list short of the ids asked for rejects like a failed request (the
    // endpoint's rule): it costs only this chunk's corrections. An item that
    // doesn't fit the price shape costs only its own, noted.
    const load = async (chunk: number[]) => {
      const { prices, odd } = summarizePurchasePrices(
        await this.#call(Steam.GetPurchaseOptions, {
          input_json: JSON.stringify({
            ids: chunk.map((appid) => ({ appid })),
            context,
            data_request: { include_all_purchase_options: true },
          }),
        }),
      );
      if (odd) {
        noteDegraded(
          priceCheck(odd),
          new ApiError({
            code: "bad_response",
            message: `${odd} GetItems purchase-option items don't fit the price shape`,
            retryable: true,
          }),
        );
      }
      return prices;
    };
    const settled = await Promise.allSettled(chunks.map(load));
    // Rejects only on a bug: the outer Promise.all in StorefrontClient.getPrices/
    // getGame would otherwise turn an enrichment's upstream failure into a
    // failed tool call.
    const parts = optionalParts(settled, (i) => priceCheck(chunks[i]!.length));
    return Object.assign({}, ...parts) as PurchasePrices;
  }

  // get_game's correction for its one appid, cached like its appdetails entry
  // (and served stale while Steam is down, so the details keep it during an
  // outage). Its item is the whole answer (GamePurchaseOptions' rule): one that
  // doesn't fit fails like a request — never cached over a good correction —
  // and costs only the correction, noted.
  async getGamePurchasePrice(
    appid: number,
    country?: string,
    language?: string,
  ): Promise<PurchasePrices> {
    const body = await optional(
      priceCheck(1),
      this.#call(
        Steam.GamePurchaseOptions,
        {
          input_json: JSON.stringify({
            ids: [{ appid }],
            context: { language: language ?? this.#l, country_code: country ?? this.#country },
            data_request: { include_all_purchase_options: true },
          }),
        },
        { cache: true },
      ),
    );
    return body ? summarizePurchasePrices(body).prices : {};
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
      minDiscount?: number;
      // Library rows that couldn't be read (noted by the caller).
      unread?: number;
    },
    tags: RecommendationTags | ApiError,
  ): Promise<Record<string, unknown>> {
    if (ownedGames.length === 0) {
      return noGamesToRecommendFrom();
    }
    if (tags instanceof ApiError) throw tags;
    const l = opts.language ?? this.#l;
    const cc = opts.country ?? this.#country;
    const { tagMap, excludeIds } = tags;
    const sample = ownedGames
      .slice()
      .sort((a, b) => b.playtimeMinutes - a.playtimeMinutes)
      .slice(0, FAVORITE_TAG_SAMPLE_SIZE);
    const sampleRes = await this.#call(Steam.GetItems, {
      input_json: JSON.stringify({
        ids: sample.map((g) => ({ appid: g.appid })),
        context: { language: l, country_code: cc },
        data_request: storeCardDataRequest(),
      }),
    });
    const tagWeights = computeFavoriteTagWeights(
      sampleRes.response?.store_items ?? [],
      new Map(sample.map((g) => [g.appid, g.playtimeMinutes])),
      tagMap,
    );
    if (tagWeights.size === 0) {
      // A taste read from a library or sample with unreadable rows (noted) is
      // no answer when it comes out empty: those rows may have been it.
      const unreadSample = (sampleRes.response?.store_items ?? []).some(
        (it) => !isRecord(it) || typeof (it.id ?? it.appid) !== "number",
      );
      if (opts.unread || unreadSample)
        throw new ApiError({
          code: "bad_response",
          message: "no taste from a library or sample with unreadable rows",
          retryable: true,
        });
      return noTasteToRecommendFrom();
    }
    const favoriteIds = [...tagWeights.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, BASED_ON_TAGS_LIMIT)
      .map(([id]) => id);

    // The pool waits for the favorite tags, so its 300 slots go to games that
    // carry at least one of them: one tagids_must_match group ORs its ids
    // (verified live — a niche visual-novel/puzzle taste went from 84 to 163
    // relevant candidates of 300). Plus, as #queryCatalog: games only, the
    // price floor and exclude_tags, all server-side; summarizeRecommendations
    // still scores and re-checks every candidate.
    const filters: Record<string, unknown> = {
      type_filters: { include_games: true },
      tagids_must_match: [{ tagids: favoriteIds }],
    };
    if (typeof opts.minDiscount === "number")
      filters.price_filters = queryDiscountFilter(opts.minDiscount);
    if (excludeIds.length) filters.tagids_exclude = excludeIds;
    // The tool schema's own min(1).max(25) already bounds this — no need to
    // re-clamp here, just fall back for direct (non-tool) callers.
    const count = opts.count ?? 10;
    const poolRes = await this.#call(Steam.Query, {
      input_json: JSON.stringify({
        query: { start: 0, count: RECOMMENDATION_POOL_SIZE, sort: 10, filters },
        context: { language: l, country_code: cc, steam_realm: 1 },
        data_request: storeCardDataRequest(),
      }),
    });
    const ownedAppids = new Set(ownedGames.map((g) => g.appid));
    noteUnsettled(unsettledItems(poolRes.response?.store_items ?? []));
    return summarizeRecommendations(
      poolRes.response?.store_items ?? [],
      tagWeights,
      ownedAppids,
      tagMap,
      count,
      tagNames(favoriteIds, tagMap),
      opts.minDiscount,
    );
  }

  // Shared catalog discovery over the keyless store query backend (discoverGames
  // is a thin preset over this). Most filters run server-side (catalogFilters);
  // the rest (SteamOS, native platform, min_reviews, a second compat dimension)
  // and the exact re-checks run in summarizeDiscover over the returned page.
  // Sorted by popularity (sort:10) so that page holds the best-known matches:
  // without a sort it is appid-ordered and fills with obscure shovelware.
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
    const { tagMap: filterTagMap, tagIds } = await this.#resolveTagFilter(p.tags, l);
    const post = {
      // Passed through so summarizeDiscover's storeItemFilter re-checks the
      // discount client-side: the server filter is a superset (a bundle's
      // discount, and 99 standing in for 100 — see queryDiscountFilter).
      minDiscount: p.minDiscount,
      minReview: p.minReview,
      minReviews: p.minReviews,
      steamDeck: p.steamDeck,
      steamOs: p.steamOs,
      steamMachine: p.steamMachine,
      steamFrame: p.steamFrame,
      platform: p.platform,
    };
    const filters = catalogFilters(p, tagIds);
    const input = {
      query: { start: p.start ?? 0, count: p.count ?? 50, sort: 10, filters },
      context: {
        language: l,
        country_code: p.country ?? this.#country,
        steam_realm: 1,
      },
      data_request: storeCardDataRequest(),
    };
    // Fetch the tag dictionary alongside the page (cached, so ~free after the
    // first call) — every card surfaces resolved tag names.
    const { res, tagMap } = await this.#fetchWithTags(
      Steam.Query,
      { input_json: JSON.stringify(input) },
      l,
      filterTagMap,
    );
    noteUnsettled(unsettledItems(res.response.store_items ?? []));
    return summarizeDiscover(res, { ...post, tagMap });
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
    // CWishlistFilters, all verified live 2026-10-20 to return only entries
    // that satisfy them: tags (every listed tagid required), Steam Deck,
    // macOS / SteamOS-Linux native builds, and a discount floor. The discount
    // is the best purchase option's (sometimes a bundle), so it is a superset
    // that storeItemFilter re-checks against the app's own package.
    const { tagMap: filterTagMap, tagIds } = await this.#resolveTagFilter(opts.tags, l);
    const server: Record<string, unknown> = {};
    if (tagIds?.length) {
      // The wishlist ANDs a flat id list (verified live: 197 and 142 entries
      // alone, 63 together), so a name with two tags can't mean "either".
      const shared = opts.tags!.filter((_, i) => tagIds[i]!.length > 1);
      if (shared.length) {
        throw new ApiError({
          code: "bad_request",
          message: `wishlist tags shared by two Steam tags in ${l}: ${shared.join(", ")}`,
          detail:
            `In ${l}, ${shared.map((n) => `"${n}"`).join(", ")} names more than one Steam tag, ` +
            "and the wishlist filter can only require each tag it's given. Filter with the " +
            "tag's name in another language, or by tag with discover_games.",
        });
      }
      server.tagids_must_match = tagIds.flat();
    }
    if (opts.steamDeck)
      server.steam_deck_filters =
        opts.steamDeck === "verified"
          ? { include_verified: true }
          : { include_verified: true, include_playable: true };
    if (opts.platform === "mac") server.macos_only = true;
    if (opts.platform === "linux") server.steamos_linux_only = true;
    const minDiscount = opts.minDiscount ?? (opts.onSaleOnly ? 1 : undefined);
    if (minDiscount !== undefined) server.min_discount_percent = minDiscount;
    // What only storeItemFilter can decide: the exact review %, the app's own-
    // package discount, and compat/platform dimensions CWishlistFilters lacks.
    const checksHere =
      (opts.minReview ?? 0) > 0 ||
      minDiscount !== undefined ||
      opts.steamOs !== undefined ||
      opts.steamMachine !== undefined ||
      opts.steamFrame !== undefined ||
      opts.platform === "windows";
    const input = {
      steamid,
      context: { language: l, country_code: opts.country ?? this.#country, steam_realm: 1 },
      data_request: storeCardDataRequest(),
      sort_order: 0, // wishlist priority, like the display order below
      filters: server,
      // A page_size past the wishlist's size is harmless (Steam cards only
      // the entries that exist, verified live), so this needn't wait for it.
      page_size: checksHere ? WISHLIST_CHECK_MAX : WISHLIST_DETAIL_MAX,
    };
    // In parallel: the plain id list for the wishlist's real size (`total`,
    // and telling "nothing matched" from "nothing shown", which a
    // server-filtered response alone can't), and the filtered cards.
    const [total, filtered] = await Promise.all([
      this.#wishlistSize(steamid),
      this.#fetchWithTags(
        Steam.GetWishlistSortedFiltered,
        { input_json: JSON.stringify(input) },
        l,
        filterTagMap,
      ),
    ]);
    // With no filter sent, Steam lists every entry: nothing listed beside a
    // wishlist that has some is no answer, never "nothing matched".
    if (Object.keys(server).length === 0 && total > 0 && !filtered.res.response.items?.length)
      throw new ApiError({
        code: "bad_response",
        message: `GetWishlistSortedFiltered listed nothing, unfiltered, for a wishlist of ${total}`,
        retryable: true,
      });
    const filters = {
      onSaleOnly: opts.onSaleOnly,
      minReview: opts.minReview,
      minDiscount: opts.minDiscount,
      platform: opts.platform,
      steamDeck: opts.steamDeck,
      steamOs: opts.steamOs,
      steamMachine: opts.steamMachine,
      steamFrame: opts.steamFrame,
    };
    return summarizeWishlistDetailed(filtered.res, filtered.tagMap, filters, {
      total,
      exact: !checksHere,
      asked: input.page_size,
    });
  }

  // The wishlist's size from the plain GetWishlist id list; 0 when Steam
  // returns none.
  async #wishlistSize(steamid: string): Promise<number> {
    const res = await this.#call(Steam.GetWishlist, { steamid });
    return res.response?.items?.length ?? 0;
  }
}
