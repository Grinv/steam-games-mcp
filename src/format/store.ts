// Response shapers for Steam's keyless store services (see AGENTS.md): one per
// service — IStoreQueryService/SearchSuggestions (search_games),
// IStoreQueryService/Query (discover_games), IStoreBrowseService/
// GetItems (get_items), IWishlistService/GetWishlistSortedFiltered (get_wishlist
// detailed) and the derived recommendations. Each trims a raw service response
// into its agent-facing shape using the shared card/tag/filter toolkit in
// ./storeCard.ts; the official Web API player formatters live in ./web.ts.
//
// Every exported summarizer builds its return value via a matching `z.strictObject()`
// zod schema's `.parse({...})` (see store.schemas.ts) instead of a bare object
// literal — the schema is the single source of truth for the shape (see
// storefront.ts's header comment for the full rationale).

import { z } from "zod";
import { capList, isoDay, storeUrl } from "./shared.ts";
import { wishlistNotFound } from "./shared.schemas.ts";
import {
  discoverGamesOutput,
  getItemsOutput,
  purchasePricesSchema,
  recommendedGamesFound,
  searchGamesOutput,
  wishlistDetailedFound,
} from "./store.schemas.ts";
import {
  baseCard,
  isOwnPackage,
  ownPurchaseOption,
  nativePlatforms,
  priceFields,
  resolveTags,
  storeCard,
  storeItemFilter,
  type StoreFilters,
  type StoreItem,
  type StoreItemsResponse,
  type StoreItemWithAppid,
  type TagMap,
} from "./storeCard.ts";

// ---- IStoreQueryService/SearchSuggestions (keyless title search) ------------

export interface SearchSuggestionsResponse {
  response?: {
    metadata?: { total_matching_records?: number };
    store_items?: StoreItem[];
  };
}

const STORE_APP_TYPE = [
  "game",
  "demo",
  "mod",
  "movie",
  "dlc",
  "guide",
  "software",
  "video",
  "series",
  "episode",
  "hardware",
  "music",
  "beta",
  "tool",
  "advertising",
] as const;

export function summarizeSearchSuggestions(
  r: SearchSuggestionsResponse,
): z.infer<typeof searchGamesOutput> {
  const results = (r.response?.store_items ?? [])
    .filter((it): it is StoreItemWithAppid => typeof it.appid === "number")
    .map((it) => {
      // Same rule as every card (ownPurchaseOption): the app's OWN package, never
      // a bundle it sits in, and never a free app's paid add-on.
      const p = priceFields(ownPurchaseOption(it));
      return {
        appid: it.appid,
        name: it.name ?? null,
        type: (typeof it.type === "number" && STORE_APP_TYPE[it.type]) || null,
        price: p.final
          ? { final: p.final, initial: p.original, discount_percent: p.discount_pct }
          : null,
        // 0 would read as a real (terrible) score; treat it as unscored, like
        // storesearch's empty string was.
        metascore: it.extra_details?.metacritic?.score
          ? String(it.extra_details.metacritic.score)
          : null,
        platforms: nativePlatforms(it.platforms),
        store_url: storeUrl(it.appid),
      };
    });
  return searchGamesOutput.parse({
    total: r.response?.metadata?.total_matching_records ?? results.length,
    returned: results.length,
    results,
  });
}

// ---- IStoreQueryService/Query (keyless catalog discovery) -------------------

export interface StoreQueryResponse {
  response?: {
    metadata?: { total_matching_records?: number; start?: number; count?: number };
    store_items?: StoreItem[];
  };
}

// Catalog-wide deal discovery. The server filters by min discount; review
// thresholds (percent / count) and discount-desc sorting are applied here over
// the returned page, since the Query API ignores those filters/sorts.
// Matches WISHLIST_DETAIL_MAX: same store-card shape. 60 cards once measured
// ~34 KB, which real MCP clients accept (~56 KB is rejected outright), but by
// 2026-10-03 a card had grown to ~550-580 B and 60 measured 33-35 KB — at that
// accepted ceiling, with nothing left for the next field Steam adds. 50 lands
// near 28 KB. Applied after filtering, and `matched` keeps the pre-cap count,
// so only an unfiltered or very broad query sees the difference.
export const DISCOVER_MAX = 50;

export function summarizeDiscover(
  r: StoreQueryResponse,
  opts: StoreFilters,
): z.infer<typeof discoverGamesOutput> {
  // Re-checks every filter exactly over the returned page. Most already ran
  // server-side (clients/storeService.ts's catalogFilters) under their correct
  // CStoreQueryFilters names; SteamOS, native platform, min_reviews and a
  // second compat dimension have no server-side form and are applied only here.
  const keep = storeItemFilter(opts);
  const rows = (r.response?.store_items ?? [])
    .filter(
      (it): it is StoreItemWithAppid =>
        it.visible !== false && typeof it.appid === "number" && keep(it),
    )
    .map((it) => storeCard(it, opts.tagMap))
    .sort((a, b) => (b.discount_pct as number) - (a.discount_pct as number));
  // Capped like every other card list: `count` scans up to 200 entries, and with
  // loose filters nearly all of them survive — ~195 cards is ~104 KB, which an
  // MCP client rejects outright for exceeding its per-result token limit, so the
  // caller gets nothing at all. That's the same failure that halved get_items'
  // and get_prices' caps; discover_games was the one card list still uncapped,
  // and its own description tells callers to "raise `count` for stricter
  // filters", steering them straight into it. Sorted by discount first, so the
  // cap keeps the best deals; `matched` still reports the true pre-cap count.
  const { included, returned } = capList(rows, DISCOVER_MAX);
  return discoverGamesOutput.parse({
    total_matching: r.response?.metadata?.total_matching_records ?? null,
    matched: rows.length,
    returned,
    deals: included,
  });
}

// ---- IStoreBrowseService/GetItems (keyless batch store data) ----------------

// Batch store card per requested appid: base card + a NESTED price block, is_free
// and coming_soon. Missing appids come back available:false.
export function summarizeItems(
  r: StoreItemsResponse,
  appids: number[],
  tagMap?: TagMap,
): z.infer<typeof getItemsOutput> {
  const byId = new Map<number, StoreItemWithAppid>();
  for (const it of r.response?.store_items ?? []) {
    // Rebuild with an explicit `appid` so TS sees the narrowed type on the
    // object itself, not just on this one property access.
    if (typeof it.appid === "number") byId.set(it.appid, { ...it, appid: it.appid });
  }
  return getItemsOutput.parse({
    count: appids.length,
    items: appids.map((appid) => {
      const it = byId.get(appid);
      // is_free is checked alongside name/best_purchase_option/reviews so a
      // free game with a sparse payload (e.g. delisted/beta F2P titles) isn't
      // misreported as unavailable — its is_free fallback below still applies.
      if (!it || (!it.name && !it.best_purchase_option && !it.reviews && !it.is_free)) {
        return { appid, available: false };
      }
      const bp = ownPurchaseOption(it);
      return {
        ...baseCard(it, tagMap),
        // Always present, so `available` discriminates every row the way
        // get_prices' does instead of being inferable only from its absence.
        available: true,
        is_free: it.is_free ?? false,
        // null covers three different situations that Steam's payload doesn't
        // separate — not sold in this country (confirmed live: appid 1174180
        // returns a name and nothing else under cc=RU, a full card under cc=US),
        // not released yet, or simply no purchase option. is_free and
        // coming_soon narrow it down; the schema says so rather than letting an
        // agent read null as "free".
        price: bp ? priceFields(bp) : it.is_free ? { is_free: true } : null,
        coming_soon: it.release?.is_coming_soon ?? false,
      };
    }),
  });
}

/** The base-game purchase price of each returned appid, keyed by appid, for
 *  overlaying onto a Storefront-API price (see format/storefront.ts's
 *  overridePrice() for why that needs correcting). An appid is simply absent
 *  when GetItems has no purchase option for it — free, unreleased or not sold
 *  in the requested country — which the caller reads as "keep what the
 *  Storefront said" rather than as "no price". */
export type PurchasePrices = z.infer<typeof purchasePricesSchema>;

export function summarizePurchasePrices(r: StoreItemsResponse): PurchasePrices {
  const out: Record<string, z.infer<typeof purchasePricesSchema>[string]> = {};
  for (const it of r.response?.store_items ?? []) {
    if (typeof it.appid !== "number") continue;
    // A bundle price prices a set of games, not this one — correcting a
    // Storefront price with it would trade a rare wrong answer for a commoner
    // one (see isOwnPackage()). Skipping leaves the Storefront price standing,
    // which in every measured bundle case was the right base-game price.
    if (!isOwnPackage(it.best_purchase_option)) continue;
    // GetItems' own is_free is the reliable one, and it's what separates a
    // genuinely free app from one appdetails only THINKS is free: Dokimon Quest
    // (appid 2019300) is free and priced $0.00 here, while theHunter: Call of
    // the Wild (518790) carries no is_free and a real $19.99 package. Skipping
    // the free ones keeps an override meaning "GetItems prices this app as a
    // paid package of its own", which is what lets it outrank appdetails'
    // is_free flag in format/storefront.ts's price().
    if (it.is_free) continue;
    const { discount_pct, final, original } = priceFields(it.best_purchase_option);
    if (!final) continue;
    out[String(it.appid)] = {
      final,
      // priceFields already falls back to final; the ?? only satisfies TS.
      initial: original ?? final,
      discount_percent: discount_pct,
    };
  }
  return purchasePricesSchema.parse(out);
}

// ---- IWishlistService/GetWishlistSortedFiltered (enriched wishlist) ----------

// Enriched wishlist: every entry embeds a full store card (store_item, same shape
// as GetItems), so "my wishlist with prices / deals" is ONE call instead of
// get_wishlist + get_items. Filtered/sorted client-side and capped for token safety.
export interface WishlistDetailedResponse {
  response?: {
    items?: { appid?: number; priority?: number; date_added?: number; store_item?: StoreItem }[];
  };
}
// Same budget as DISCOVER_MAX above (same card shape).
export const WISHLIST_DETAIL_MAX = 50;
export function summarizeWishlistDetailed(
  r: WishlistDetailedResponse,
  tagMap: TagMap | undefined,
  opts: StoreFilters,
  // total: the whole wishlist's size, from the plain GetWishlist list (a
  // server-filtered response only lists matches). exact: every filter ran
  // server-side, so the listed entries ARE the matches and only the displayed
  // page needed cards; otherwise storeItemFilter re-checks each carded match.
  ctx: { total: number; exact: boolean },
): z.infer<typeof wishlistNotFound> | z.infer<typeof wishlistDetailedFound> {
  if (ctx.total === 0) {
    return wishlistNotFound.parse({
      found: false,
      reason: "Empty wishlist, or the profile/wishlist is private.",
      total: 0,
      items: [],
    });
  }
  const items = r.response?.items ?? [];
  const enriched = items.filter(
    (i): i is typeof i & { store_item: StoreItem } => i.store_item !== undefined,
  );
  const keep = storeItemFilter({ ...opts, tagMap });
  const cards = enriched
    .filter(
      (i): i is typeof i & { store_item: StoreItemWithAppid } =>
        typeof i.store_item.appid === "number" && (ctx.exact || keep(i.store_item)),
    )
    .map((i) => ({
      ...storeCard(i.store_item, tagMap),
      priority: i.priority ?? null,
      added: isoDay(i.date_added),
    }));
  // Rank by discount when a discount filter is active; else keep wishlist priority.
  const byDiscount = opts.onSaleOnly || typeof opts.minDiscount === "number";
  cards.sort((a, b) =>
    byDiscount ? b.discount_pct - a.discount_pct : (a.priority ?? 1e9) - (b.priority ?? 1e9),
  );
  const { included, returned } = capList(cards, WISHLIST_DETAIL_MAX);
  const unchecked = ctx.exact ? 0 : items.length - enriched.length;
  return wishlistDetailedFound.parse({
    found: true,
    total: ctx.total,
    enriched: enriched.length,
    note:
      unchecked > 0
        ? `${items.length} wishlist items passed Steam's own filters, but only the first ` +
          `${enriched.length} were checked against the rest (review %, own-package discount, ` +
          "compat/platform) — narrow the filters to cover them all."
        : undefined,
    matched: ctx.exact ? items.length : cards.length,
    returned,
    items: included,
  });
}

// ---- personalized recommendations (derived from the player's own library) --

// Turns a sample of the player's owned games (already fetched as store items,
// so their tags can be resolved) into weighted tag preferences: each game's
// tags gain its own playtime (hours) as weight, so heavily-played games
// dominate. Zero/unknown playtime contributes nothing. Used by
// clients/storeService.ts#getRecommendedGames.
export function computeFavoriteTagWeights(
  ownedItems: StoreItem[],
  playtimeMinutesByAppid: Map<number, number>,
  tagMap: TagMap,
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const it of ownedItems) {
    if (typeof it.appid !== "number") continue;
    const hoursPlayed = (playtimeMinutesByAppid.get(it.appid) ?? 0) / 60;
    if (hoursPlayed <= 0) continue;
    for (const tag of resolveTags(it.tags, tagMap)) {
      weights.set(tag, (weights.get(tag) ?? 0) + hoursPlayed);
    }
  }
  return weights;
}

// Ranks unowned catalog items by overlap with the player's weighted tag
// preferences, discounted by how well-reviewed each candidate is — a locally
// computed ranking: the Query API can narrow the pool to games carrying ANY of
// the favorite tags (clients/storeService.ts does), but has no weighted "similar
// to my library" ranking, and doesn't rank by review quality either.
export function summarizeRecommendations(
  candidates: StoreItem[],
  tagWeights: Map<string, number>,
  ownedAppids: Set<number>,
  tagMap: TagMap | undefined,
  max: number,
  basedOnTags: string[],
  minDiscount?: number,
): z.infer<typeof recommendedGamesFound> {
  // Games-only and exclude_tags already ran server-side on the pool
  // (clients/storeService.ts), so only ownership and the discount backstop
  // remain here.
  const scored = candidates
    .filter(
      (it): it is StoreItemWithAppid =>
        it.visible !== false &&
        typeof it.appid === "number" &&
        !ownedAppids.has(it.appid) &&
        // Client-side discount backstop: like summarizeDiscover, Steam's
        // server-side min_discount_percent no-ops at 100, so re-check here.
        (minDiscount === undefined || (ownPurchaseOption(it)?.discount_pct ?? 0) >= minDiscount),
    )
    .map((it) => {
      const tags = resolveTags(it.tags, tagMap);
      const matchedTags = tags.filter((t) => tagWeights.has(t));
      const tagScore = matchedTags.reduce((sum, t) => sum + (tagWeights.get(t) ?? 0), 0);
      // Discount by review quality so a tag match on a poorly-received game
      // doesn't outrank a better one; missing review data (too new/rare to
      // judge) stays neutral (×1) rather than being penalized as if bad.
      const reviewPercent = it.reviews?.summary_filtered?.percent_positive;
      const reviewMultiplier = typeof reviewPercent === "number" ? reviewPercent / 100 : 1;
      return { it, matchedTags, matchScore: tagScore * reviewMultiplier };
    })
    .filter((x) => x.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, max);
  return recommendedGamesFound.parse({
    found: true,
    based_on_tags: basedOnTags,
    count: scored.length,
    recommendations: scored.map(({ it, matchedTags, matchScore }) => ({
      ...storeCard(it, tagMap),
      matched_tags: matchedTags,
      match_score: Math.round(matchScore * 10) / 10,
    })),
  });
}
