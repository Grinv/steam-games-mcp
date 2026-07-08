// Formatters for Steam's keyless store services — IStoreBrowseService/GetItems,
// IStoreQueryService/Query and IWishlistService/GetWishlistSortedFiltered — plus
// the IStoreService/GetTagList dictionary. These are the undocumented store APIs
// (see AGENTS.md); the official Web API player formatters live in ./web.ts.
// All three services return the same `StoreItem` shape, so one card builder
// (baseCard/storeCard) and one set of tag/compat/platform helpers serve them all.

import { isoDateTime, isoDay, storeUrl } from "./shared.js";

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
  // steam_deck = Steam Deck; steam_os = SteamOS in general (any SteamOS device incl.
  // the Steam Machine, not Steam-Machine-specific); steam_frame = the Steam Frame VR headset.
  platforms?: {
    windows?: boolean;
    mac?: boolean;
    steamos_linux?: boolean; // native Linux/SteamOS build (distinct from the Proton compat rating)
    steam_deck_compat_category?: number;
    steam_os_compat_category?: number;
    steam_frame_compat_category?: number;
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

// Case-insensitive AND-match against an item's FULL tag set — NOT the capped
// display list a card shows. Filtering must see every fetched tag, or a match on
// a lower-weighted tag (e.g. "Metroidvania" on a game whose top tags are others)
// would be dropped just because it fell past the display cap.
function matchesAllTags(
  tags: { tagid?: number; weight?: number }[] | undefined,
  tagMap: TagMap | undefined,
  wantLower: string[],
): boolean {
  const have = new Set(
    (tags ?? [])
      .map((t) => (t.tagid !== undefined ? tagMap?.[t.tagid] : undefined))
      .filter((n): n is string => Boolean(n))
      .map((n) => n.toLowerCase()),
  );
  return wantLower.every((t) => have.has(t));
}

// ---- compatibility + native platforms ---------------------------------------

// Valve's compatibility enum, shared by all three platforms.*_compat_category
// fields (Steam Deck, SteamOS, Steam Frame) — same badges, same review process.
const COMPAT_CATEGORY: Record<number, string> = {
  0: "unknown",
  1: "unsupported",
  2: "playable",
  3: "verified",
};
function compat(cat?: number): string {
  return COMPAT_CATEGORY[cat ?? 0] ?? "unknown";
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
// append their own price block (flat for discover, nested for get_items).
function baseCard(it: StoreItem, tagMap?: TagMap): Record<string, unknown> {
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
    steam_frame: compat(it.platforms?.steam_frame_compat_category),
    tags: resolveTags(it.tags, tagMap),
    release_date: isoDay(it.release?.steam_release_date),
  };
}

// Compact card with a FLAT price (shared by discover_games and the wishlist
// detailed view). get_items uses a nested price block instead (see summarizeItems).
function storeCard(it: StoreItem, tagMap?: TagMap): Record<string, unknown> {
  const { final, ...rest } = priceFields(it.best_purchase_option);
  return {
    ...baseCard(it, tagMap),
    ...rest,
    price: final,
  };
}

// ---- shared client-side filter ---------------------------------------------

// Every filter discover_games and the wishlist detailed view apply, client-side,
// over the raw store items. All optional — an unset field passes everything.
// (Steam's store APIs ignore most of these server-side, hence we filter here.)
interface StoreFilters {
  minReview?: number;
  minReviews?: number;
  minDiscount?: number;
  onSaleOnly?: boolean;
  steamDeck?: string;
  steamOs?: string;
  steamFrame?: string;
  platform?: keyof typeof PLATFORM_FIELD;
  releasedAfter?: number;
  tags?: string[];
  tagMap?: TagMap;
}

// Resolve the options once (compat mins, native-platform flag, wanted tag names)
// into a per-item predicate. Compat is checked on the raw category ints and tags
// on the FULL tag set (not the capped display list), so both callers filter
// identically without duplicating the logic. Exported for focused unit tests.
export function storeItemFilter(f: StoreFilters): (it: StoreItem) => boolean {
  const deckMin = f.steamDeck ? COMPAT_MIN[f.steamDeck] : undefined;
  const osMin = f.steamOs ? COMPAT_MIN[f.steamOs] : undefined;
  const frameMin = f.steamFrame ? COMPAT_MIN[f.steamFrame] : undefined;
  const platformField = f.platform ? PLATFORM_FIELD[f.platform] : undefined;
  const wantTags = f.tags?.length ? f.tags.map((t) => t.toLowerCase()) : undefined;
  return (it) => {
    const p = it.platforms;
    if (deckMin !== undefined && (p?.steam_deck_compat_category ?? 0) < deckMin) return false;
    if (osMin !== undefined && (p?.steam_os_compat_category ?? 0) < osMin) return false;
    if (frameMin !== undefined && (p?.steam_frame_compat_category ?? 0) < frameMin) return false;
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
): Record<string, unknown> {
  // Filters run over the returned page — Steam's Query API silently ignores review,
  // Deck/compat, native-platform, tag and release-date filters, so they only narrow
  // the popularity-first scan window.
  const keep = storeItemFilter(opts);
  const rows = (r.response?.store_items ?? [])
    .filter((it) => it.visible !== false && typeof it.appid === "number" && keep(it))
    .map((it) => storeCard(it, opts.tagMap))
    .sort((a, b) => (b.discount_pct as number) - (a.discount_pct as number));
  return {
    total_matching: r.response?.metadata?.total_matching_records ?? null,
    returned: rows.length,
    deals: rows,
  };
}

// ---- IStoreBrowseService/GetItems (keyless batch store data) ----------------

// Batch store card per requested appid: base card + a NESTED price block, is_free
// and coming_soon. Missing appids come back available:false.
export function summarizeItems(
  r: StoreItemsResponse,
  appids: number[],
  tagMap?: TagMap,
): Record<string, unknown> {
  const byId = new Map<number, StoreItem>();
  for (const it of r.response?.store_items ?? [])
    if (typeof it.appid === "number") byId.set(it.appid, it);
  return {
    count: appids.length,
    items: appids.map((appid) => {
      const it = byId.get(appid);
      if (!it || (!it.name && !it.best_purchase_option && !it.reviews)) {
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
  };
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
): Record<string, unknown> {
  const items = r.response?.items ?? [];
  if (items.length === 0) {
    return {
      found: false,
      reason: "Empty wishlist, or the profile/wishlist is private.",
      total: 0,
      items: [],
    };
  }
  // Filters run over the WHOLE wishlist (same predicate as discover_games) before
  // the output cap, so a match — e.g. a deeply-discounted niche game whose matching
  // tag falls past the display cap — is never hidden by the cap or the sort window.
  const keep = storeItemFilter({ ...opts, tagMap });
  const cards: Record<string, unknown>[] = items
    .filter((i) => i.store_item && typeof i.appid === "number" && keep(i.store_item!))
    .map((i) => ({
      ...storeCard(i.store_item!, tagMap),
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
  return {
    found: true,
    total: items.length,
    matched: cards.length,
    returned: Math.min(cards.length, WISHLIST_DETAIL_MAX),
    items: cards.slice(0, WISHLIST_DETAIL_MAX),
  };
}
