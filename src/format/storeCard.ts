// Store-card toolkit for Steam's keyless store services (see AGENTS.md): the
// StoreItem shape plus the tag-dictionary, compatibility, price and client-side
// filter helpers that build one trimmed card (baseCard/storeCard) and filter raw
// store items. Shared foundation for format/store.ts's four service summarizers
// (GetItems, Query/discover, GetWishlistSortedFiltered, recommendations) and
// their unit tests, split out of store.ts once it grew past ~550 lines so the
// card/filter primitives live in one place, separate from the response shapers
// that consume them. Zod schemas in store.schemas.ts.
import { z } from "zod";
import { isoDateTime, isoDay, storeUrl } from "./shared.js";
import {
  baseCardSchema,
  compatBadgeSchema,
  compatFilterSchema,
  storeCardSchema,
  vrSupportSchema,
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
  // Present (with the base game's appid) on DLC, soundtracks and other
  // non-standalone items; absent on a base game/app itself — verified live
  // against IStoreBrowseService/GetItems (e.g. a DLC/soundtrack always carries
  // this, a base game like Portal 2 never does). Used by isBaseGame() below to
  // keep catalog-discovery results (discover_games, get_recommended_games) to
  // actual games, not their DLC/soundtracks.
  related_items?: { parent_appid?: number };
}
export interface StoreItemsResponse {
  response?: { store_items?: StoreItem[] };
}

// baseCard()/storeCard() need a real appid to build a card (it's a required,
// non-nullable field on baseCardSchema) — every call site narrows to this
// before calling either, since a StoreItem's own appid is optional.
export type StoreItemWithAppid = StoreItem & { appid: number };

// Catalog-DISCOVERY results (discover_games, get_recommended_games) should
// surface actual games, not their DLC/soundtracks/upgrade-kits — an appid the
// caller already knows about (get_items, get_wishlist) has no such filter,
// since those legitimately list DLC the player owns/wants.
export function isBaseGame(it: StoreItem): boolean {
  return it.related_items?.parent_appid === undefined;
}

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
export function resolveTags(
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
export function matchesAnyTag(
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
function vrSupport(p: StoreItem["platforms"]): z.infer<typeof vrSupportSchema> {
  const vr = p?.vr_support;
  if (!vr?.vrhmd) return vrSupportSchema.enum.none;
  return vr.vrhmd_only ? vrSupportSchema.enum.required : vrSupportSchema.enum.supported;
}
// Map a user-facing compat filter to the minimum acceptable category: "verified"
// keeps only Verified; "playable" keeps Playable or Verified (i.e. "runs on it").
const COMPAT_MIN: Record<z.infer<typeof compatFilterSchema>, number> = { verified: 3, playable: 2 };

// User-facing native-platform name → the raw platforms.* boolean flag. "linux"
// maps to steamos_linux (a native Linux/SteamOS build), NOT the SteamOS Proton
// compat rating (steam_os_compat_category) — those are deliberately separate.
const PLATFORM_FIELD = {
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
export function priceFields(bp: StoreItem["best_purchase_option"]): {
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
export function baseCard(it: StoreItemWithAppid, tagMap?: TagMap): z.infer<typeof baseCardSchema> {
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
export function storeCard(
  it: StoreItemWithAppid,
  tagMap?: TagMap,
): z.infer<typeof storeCardSchema> {
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
  steamDeck?: z.infer<typeof compatFilterSchema>;
  steamOs?: z.infer<typeof compatFilterSchema>;
  steamMachine?: z.infer<typeof compatFilterSchema>;
  steamFrame?: z.infer<typeof compatFilterSchema>;
}

// Every filter discover_games and the wishlist detailed view apply, client-side,
// over the raw store items. All optional — an unset field passes everything.
// (Steam's store APIs ignore most of these server-side, hence we filter here.)
export interface StoreFilters extends CompatFilters {
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
    // minReview > 0 guard: a 0 threshold means "no minimum", so it must NOT
    // drop games that carry no review summary yet (the -1 missing-data sentinel
    // would otherwise fail 0). Mirrors minReviews' ?? 0 no-op-at-zero behavior.
    if (
      typeof f.minReview === "number" &&
      f.minReview > 0 &&
      (rev?.percent_positive ?? -1) < f.minReview
    )
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
