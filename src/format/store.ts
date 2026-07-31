// Response shapers for Steam's keyless store services (see AGENTS.md): one per
// service — IStoreQueryService/Query (discover_games), IStoreBrowseService/
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
import { capList, isoDay } from "./shared.js";
import { wishlistNotFound } from "./shared.schemas.js";
import {
  discoverGamesOutput,
  getItemsOutput,
  recommendedGamesFound,
  wishlistDetailedFound,
} from "./store.schemas.js";
import {
  baseCard,
  isBaseGame,
  matchesAnyTag,
  priceFields,
  resolveTags,
  storeCard,
  storeItemFilter,
  type StoreFilters,
  type StoreItem,
  type StoreItemsResponse,
  type StoreItemWithAppid,
  type TagMap,
} from "./storeCard.js";

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
export function summarizeDiscover(
  r: StoreQueryResponse,
  opts: StoreFilters,
): z.infer<typeof discoverGamesOutput> {
  // Filters run over the returned page — Steam's Query API silently ignores review,
  // Deck/compat, native-platform, tag and release-date filters, so they only narrow
  // the popularity-first scan window.
  const keep = storeItemFilter(opts);
  const rows = (r.response?.store_items ?? [])
    .filter(
      (it): it is StoreItemWithAppid =>
        it.visible !== false && typeof it.appid === "number" && isBaseGame(it) && keep(it),
    )
    .map((it) => storeCard(it, opts.tagMap))
    .sort((a, b) => (b.discount_pct as number) - (a.discount_pct as number));
  return discoverGamesOutput.parse({
    total_matching: r.response?.metadata?.total_matching_records ?? null,
    returned: rows.length,
    deals: rows,
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
      const bp = it.best_purchase_option;
      return {
        ...baseCard(it, tagMap),
        is_free: it.is_free ?? false,
        price: bp ? priceFields(bp) : it.is_free ? { is_free: true } : null,
        coming_soon: it.release?.is_coming_soon ?? false,
      };
    }),
  });
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
export const WISHLIST_DETAIL_MAX = 60;
export function summarizeWishlistDetailed(
  r: WishlistDetailedResponse,
  tagMap?: TagMap,
  opts: StoreFilters = {},
): z.infer<typeof wishlistNotFound> | z.infer<typeof wishlistDetailedFound> {
  const items = r.response?.items ?? [];
  if (items.length === 0) {
    return wishlistNotFound.parse({
      found: false,
      reason: "Empty wishlist, or the profile/wishlist is private.",
      total: 0,
      items: [],
    });
  }
  // Steam only attaches a store_item card to the first ~100 entries of a
  // wishlist, however many count/start params this call sends (verified live —
  // it doesn't budge) — so on a >100-item wishlist, filters below only ever see
  // that enriched prefix, NOT the whole wishlist as the tool description used to
  // (wrongly) promise. Entries past it carry no price/reviews/tags to filter on.
  const enriched = items.filter(
    (i): i is typeof i & { store_item: StoreItem } => i.store_item !== undefined,
  );
  const keep = storeItemFilter({ ...opts, tagMap });
  const cards = enriched
    .filter(
      (i): i is typeof i & { store_item: StoreItemWithAppid } =>
        typeof i.store_item.appid === "number" && keep(i.store_item),
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
  return wishlistDetailedFound.parse({
    found: true,
    total: items.length,
    enriched: enriched.length,
    note:
      enriched.length < items.length
        ? `Steam only returned store data for ${enriched.length} of ${items.length} wishlist ` +
          `items; filters/matches only cover those ${enriched.length} — the rest have no price, ` +
          "reviews or tags to check."
        : undefined,
    matched: cards.length,
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
// computed ranking, since the Query API has no "similar to my library" or
// OR-tag mode of its own (its own tags filter is AND-only, unsuitable for "any
// of my several favorite tags"), and doesn't rank by review quality either.
export function summarizeRecommendations(
  candidates: StoreItem[],
  tagWeights: Map<string, number>,
  ownedAppids: Set<number>,
  tagMap: TagMap | undefined,
  max: number,
  basedOnTags: string[],
  excludeTags: string[] = [],
  minDiscount?: number,
): z.infer<typeof recommendedGamesFound> {
  const excludeLower = excludeTags.map((t) => t.toLowerCase());
  const scored = candidates
    .filter(
      (it): it is StoreItemWithAppid =>
        it.visible !== false &&
        typeof it.appid === "number" &&
        isBaseGame(it) &&
        !ownedAppids.has(it.appid) &&
        !(excludeLower.length && matchesAnyTag(it.tags, tagMap, excludeLower)) &&
        // Client-side discount backstop: like summarizeDiscover, Steam's
        // server-side min_discount_percent no-ops at 100, so re-check here.
        (minDiscount === undefined || (it.best_purchase_option?.discount_pct ?? 0) >= minDiscount),
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
