// Formatters for Steam's keyless store services — IStoreBrowseService/GetItems,
// IStoreQueryService/Query and IWishlistService/GetWishlistSortedFiltered — plus
// the IStoreService/GetTagList dictionary. These are the undocumented store APIs
// (see AGENTS.md); the official Web API player formatters live in ./web.ts.
// All three services return the same `StoreItem` shape, so one card builder
// (baseCard/storeCard) and one set of tag/compat/platform helpers serve them all.
//
// Every exported summarizer builds its return value via a matching `.strict()`
// zod schema's `.parse({...})` (see store.schemas.ts) instead of a bare object
// literal — the schema is the single source of truth for the shape (see
// storefront.ts's header comment for the full rationale).

import { z } from "zod";
import { isoDateTime, isoDay, storeUrl } from "./shared.js";
import { wishlistNotFound } from "./shared.schemas.js";
import {
  baseCardSchema,
  compatBadgeSchema,
  discoverGamesOutput,
  getItemsOutput,
  recommendedGamesFound,
  storeCardSchema,
  wishlistDetailedFound,
} from "./store.schemas.js";

// ---- shared StoreItem shape -------------------------------------------------

export interface StoreItem {
  appid?: number;
  name?: string;
  is_free?: boolean;
  best_purchase_option?: {
    formatted_final_price?: string;
    formatted_original_price?: string;
    discount_pct?: number;
    // Each active discount carries when it ends (unix seconds); see discountEnd().
    active_discounts?: { discount_end_date?: number }[];
  };
  reviews?: {
    summary_filtered?: {
      review_count?: number;
      percent_positive?: number;
      review_score_label?: string;
    };
  };
  release?: { steam_release_date?: number; is_coming_soon?: boolean };
  // Valve's compatibility enums (returned with include_platforms): see COMPAT_CATEGORY.
  // steam_deck = Steam Deck; steam_os = SteamOS in general (any SteamOS device);
  // steam_machine = the Steam Machine console specifically (its own rating, distinct
  // from the general steam_os one); steam_frame = the Steam Frame VR headset.
  platforms?: {
    windows?: boolean;
    mac?: boolean;
    steamos_linux?: boolean; // native Linux/SteamOS build (distinct from the Proton compat rating)
    steam_deck_compat_category?: number;
    steam_os_compat_category?: number;
    steam_machine_compat_category?: number;
    steam_frame_compat_category?: number;
    // Absent entirely for a non-VR game; vrhmd present (true) means VR is
    // supported, vrhmd_only means it's VR-exclusive (no flatscreen mode).
    vr_support?: { vrhmd?: boolean; vrhmd_only?: boolean };
  };
  // Popular user-defined tags (returned with include_tag_count), most-weighted
  // first. Only tagid + weight — names are resolved from the tag dictionary (see
  // TagMap / GetTagListResponse), so a card carries human-readable tag names.
  tags?: { tagid?: number; weight?: number }[];
  visible?: boolean;
}
export interface StoreItemsResponse {
  response?: { store_items?: StoreItem[] };
}

// baseCard()/storeCard() need a real appid to build a card (it's a required,
// non-nullable field on baseCardSchema) — every call site below narrows to
// this before calling either, since a StoreItem's own appid is optional.
type StoreItemWithAppid = StoreItem & { appid: number };

// ---- tag dictionary (IStoreService/GetTagList) ------------------------------

// tagid → localized name, from IStoreService/GetTagList (keyless). Passed into the
// card builders so store_items' numeric tagids become readable tag names.
export type TagMap = Record<number, string>;
export interface GetTagListResponse {
  response?: { version_hash?: string; tags?: { tagid?: number; name?: string }[] };
}
export function summarizeTagList(r: GetTagListResponse): TagMap {
  const map: TagMap = {};
  for (const t of r.response?.tags ?? [])
    if (typeof t.tagid === "number" && t.name) map[t.tagid] = t.name;
  return map;
}
// How many resolved tag names to surface per card (most-weighted first). Bounded
// to keep batch responses (up to 100 items) token-efficient.
const TAG_LIMIT = 8;
function resolveTags(
  tags: { tagid?: number; weight?: number }[] | undefined,
  tagMap: TagMap | undefined,
): string[] {
  if (!tags || !tagMap) return [];
  return tags
    .slice()
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .map((t) => (t.tagid !== undefined ? tagMap[t.tagid] : undefined))
    .filter((name): name is string => Boolean(name))
    .slice(0, TAG_LIMIT);
}

// An item's FULL resolved tag-name set, lowercased — NOT the capped display
// list a card shows (see resolveTags' TAG_LIMIT). Shared by matchesAllTags and
// matchesAnyTag so both see every fetched tag, not just the most-weighted ones.
function fullTagNamesLower(
  tags: { tagid?: number; weight?: number }[] | undefined,
  tagMap: TagMap | undefined,
): Set<string> {
  return new Set(
    (tags ?? [])
      .map((t) => (t.tagid !== undefined ? tagMap?.[t.tagid] : undefined))
      .filter((n): n is string => Boolean(n))
      .map((n) => n.toLowerCase()),
  );
}

// Case-insensitive AND-match against an item's FULL tag set — a match on a
// lower-weighted tag (e.g. "Metroidvania" on a game whose top tags are others)
// must still count, or it'd be dropped just because it fell past the display cap.
function matchesAllTags(
  tags: { tagid?: number; weight?: number }[] | undefined,
  tagMap: TagMap | undefined,
  wantLower: string[],
): boolean {
  const have = fullTagNamesLower(tags, tagMap);
  return wantLower.every((t) => have.has(t));
}

// Case-insensitive OR-match against an item's FULL tag set — used to EXCLUDE
// candidates carrying ANY of a set of unwanted tags (e.g. "recommend me
// something except Souls-like").
function matchesAnyTag(
  tags: { tagid?: number; weight?: number }[] | undefined,
  tagMap: TagMap | undefined,
  unwantedLower: string[],
): boolean {
  const have = fullTagNamesLower(tags, tagMap);
  return unwantedLower.some((t) => have.has(t));
}

// ---- compatibility + native platforms ---------------------------------------

// Valve's compatibility enum, shared by all four platforms.*_compat_category
// fields (Steam Deck, SteamOS, Steam Machine, Steam Frame) — same badges, same review process.
const COMPAT_CATEGORY: Record<number, z.infer<typeof compatBadgeSchema>> = {
  0: "unknown",
  1: "unsupported",
  2: "playable",
  3: "verified",
};
function compat(cat?: number): z.infer<typeof compatBadgeSchema> {
  return COMPAT_CATEGORY[cat ?? 0] ?? "unknown";
}

// "none": no VR headset support at all (the common case); "supported": works
// with a VR headset but also playable flatscreen; "required": VR-only, no
// flatscreen mode. Steam omits vr_support (or its sub-fields) entirely rather
// than sending explicit false, hence the `?? false` defaults below.
function vrSupport(p: StoreItem["platforms"]): "none" | "supported" | "required" {
  const vr = p?.vr_support;
  if (!vr?.vrhmd) return "none";
  return vr.vrhmd_only ? "required" : "supported";
}
// Map a user-facing compat filter to the minimum acceptable category: "verified"
// keeps only Verified; "playable" keeps Playable or Verified (i.e. "runs on it").
export const COMPAT_MIN: Record<string, number> = { verified: 3, playable: 2 };

// User-facing native-platform name → the raw platforms.* boolean flag. "linux"
// maps to steamos_linux (a native Linux/SteamOS build), NOT the SteamOS Proton
// compat rating (steam_os_compat_category) — those are deliberately separate.
export const PLATFORM_FIELD = {
  windows: "windows",
  mac: "mac",
  linux: "steamos_linux",
} as const;
function nativePlatforms(p: StoreItem["platforms"]): string[] {
  if (!p) return [];
  const out: string[] = [];
  if (p.windows) out.push("windows");
  if (p.mac) out.push("mac");
  if (p.steamos_linux) out.push("linux");
  return out;
}

// When the current discount ends, as a full ISO 8601 UTC timestamp — the SOONEST
// active discount's end (that's when the shown price first changes), or null when
// not discounted. active_discounts is usually a single entry.
function discountEnd(bp: StoreItem["best_purchase_option"]): string | null {
  const ends = (bp?.active_discounts ?? [])
    .map((d) => d.discount_end_date)
    .filter((t): t is number => typeof t === "number" && t > 0);
  return ends.length ? isoDateTime(Math.min(...ends)) : null;
}

// Shared discount_pct/discount_end/final/original derivation from
// best_purchase_option — used by both storeCard's flat price shape and
// summarizeItems' nested `price` shape, so the two never drift on the
// original-price fallback rule.
function priceFields(bp: StoreItem["best_purchase_option"]): {
  discount_pct: number;
  discount_end: string | null;
  final: string | null;
  original: string | null;
} {
  return {
    discount_pct: bp?.discount_pct ?? 0,
    discount_end: discountEnd(bp),
    final: bp?.formatted_final_price || null,
    original: bp?.formatted_original_price || bp?.formatted_final_price || null,
  };
}

// ---- store cards ------------------------------------------------------------

// Fields common to every store card, independent of how price is shaped. Callers
// append their own price block (flat for discover, nested for get_items). Not
// `.parse()`d here — the exported summarizer that embeds a card already
// validates the whole result once (get_items/discover_games/get_wishlist can
// return up to hundreds of cards per call, so re-validating each one twice on
// top of that would be pure overhead). The `z.infer` return type still gets
// this checked at the TS level.
function baseCard(it: StoreItemWithAppid, tagMap?: TagMap): z.infer<typeof baseCardSchema> {
  const rev = it.reviews?.summary_filtered;
  return {
    appid: it.appid,
    name: it.name ?? null,
    store_url: storeUrl(it.appid),
    review_percent: rev?.percent_positive ?? null,
    review_count: rev?.review_count ?? null,
    review_label: rev?.review_score_label ?? null,
    platforms: nativePlatforms(it.platforms),
    steam_deck: compat(it.platforms?.steam_deck_compat_category),
    steam_os: compat(it.platforms?.steam_os_compat_category),
    steam_machine: compat(it.platforms?.steam_machine_compat_category),
    steam_frame: compat(it.platforms?.steam_frame_compat_category),
    vr_support: vrSupport(it.platforms),
    tags: resolveTags(it.tags, tagMap),
    release_date: isoDay(it.release?.steam_release_date),
  };
}

// Compact card with a FLAT price (shared by discover_games and the wishlist
// detailed view). get_items uses a nested price block instead (see summarizeItems).
function storeCard(it: StoreItemWithAppid, tagMap?: TagMap): z.infer<typeof storeCardSchema> {
  const { final, ...rest } = priceFields(it.best_purchase_option);
  return {
    ...baseCard(it, tagMap),
    ...rest,
    price: final,
  };
}

// ---- shared client-side filter ---------------------------------------------

// The four hardware-compat filters, shared by StoreFilters here and by every
// clients/storeService.ts method that accepts them (#queryCatalog, discoverGames,
// getWishlistDetailed) — one place to add a 5th Valve compat dimension instead of
// three copy-pasted signatures.
export interface CompatFilters {
  steamDeck?: string;
  steamOs?: string;
  steamMachine?: string;
  steamFrame?: string;
}

// Every filter discover_games and the wishlist detailed view apply, client-side,
// over the raw store items. All optional — an unset field passes everything.
// (Steam's store APIs ignore most of these server-side, hence we filter here.)
interface StoreFilters extends CompatFilters {
  minReview?: number;
  minReviews?: number;
  minDiscount?: number;
  onSaleOnly?: boolean;
  platform?: keyof typeof PLATFORM_FIELD;
  releasedAfter?: number;
  tags?: string[];
  tagMap?: TagMap;
}

// Each compat filter dimension: which StoreFilters key holds the user's choice,
// and which platforms.*_compat_category field it's checked against. Table-driven
// so a future compat dimension (Valve keeps adding hardware SKUs) is one row,
// not another copy-pasted `if` — TypeScript can't catch a forgotten `if`, but it
// can't forget a table row that storeItemFilter's own loop always applies.
const COMPAT_FILTERS = [
  ["steamDeck", "steam_deck_compat_category"],
  ["steamOs", "steam_os_compat_category"],
  ["steamMachine", "steam_machine_compat_category"],
  ["steamFrame", "steam_frame_compat_category"],
] as const satisfies readonly [keyof StoreFilters, keyof NonNullable<StoreItem["platforms"]>][];

// Resolve the options once (compat mins, native-platform flag, wanted tag names)
// into a per-item predicate. Compat is checked on the raw category ints and tags
// on the FULL tag set (not the capped display list), so both callers filter
// identically without duplicating the logic. Exported for focused unit tests.
export function storeItemFilter(f: StoreFilters): (it: StoreItem) => boolean {
  const compatMins = COMPAT_FILTERS.map(([filterKey, categoryField]) => {
    const chosen = f[filterKey];
    return [categoryField, chosen ? COMPAT_MIN[chosen] : undefined] as const;
  });
  const platformField = f.platform ? PLATFORM_FIELD[f.platform] : undefined;
  const wantTags = f.tags?.length ? f.tags.map((t) => t.toLowerCase()) : undefined;
  return (it) => {
    const p = it.platforms;
    for (const [categoryField, min] of compatMins) {
      if (min !== undefined && (p?.[categoryField] ?? 0) < min) return false;
    }
    if (platformField && !p?.[platformField]) return false;
    if (f.releasedAfter !== undefined && (it.release?.steam_release_date ?? 0) < f.releasedAfter)
      return false;
    if (wantTags && !matchesAllTags(it.tags, f.tagMap, wantTags)) return false;
    const rev = it.reviews?.summary_filtered;
    if (typeof f.minReview === "number" && (rev?.percent_positive ?? -1) < f.minReview)
      return false;
    if (typeof f.minReviews === "number" && (rev?.review_count ?? 0) < f.minReviews) return false;
    const disc = it.best_purchase_option?.discount_pct ?? 0;
    if (typeof f.minDiscount === "number") {
      if (disc < f.minDiscount) return false;
    } else if (f.onSaleOnly && disc <= 0) {
      return false;
    }
    return true;
  };
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
        it.visible !== false && typeof it.appid === "number" && keep(it),
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
const WISHLIST_DETAIL_MAX = 60;
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
  const cards: Record<string, unknown>[] = enriched
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
    byDiscount
      ? (b.discount_pct as number) - (a.discount_pct as number)
      : ((a.priority as number | null) ?? 1e9) - ((b.priority as number | null) ?? 1e9),
  );
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
    returned: Math.min(cards.length, WISHLIST_DETAIL_MAX),
    items: cards.slice(0, WISHLIST_DETAIL_MAX),
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
): z.infer<typeof recommendedGamesFound> {
  const excludeLower = excludeTags.map((t) => t.toLowerCase());
  const scored = candidates
    .filter(
      (it): it is StoreItemWithAppid =>
        it.visible !== false &&
        typeof it.appid === "number" &&
        !ownedAppids.has(it.appid) &&
        !(excludeLower.length && matchesAnyTag(it.tags, tagMap, excludeLower)),
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
