// Trims verbose Steam Web API payloads (api.steampowered.com) down to the fields
// an agent needs: player profiles/library/achievements, game news + achievement
// rarity, plus the keyless store services (IStoreBrowseService/GetItems and
// IStoreQueryService/Query). Companion to ./storefront.ts and ./shared.ts.

import { hours, isoDay, stripHtml } from "./shared.js";

// ---- Web API: player summary ------------------------------------------------

interface PlayerSummary {
  steamid?: string;
  personaname?: string;
  profileurl?: string;
  avatarfull?: string;
  personastate?: number;
  realname?: string;
  loccountrycode?: string;
  timecreated?: number;
  communityvisibilitystate?: number;
  gameextrainfo?: string;
  gameid?: string;
}
export interface PlayerSummariesResponse {
  response?: { players?: PlayerSummary[] };
}

const PERSONA_STATES = [
  "offline",
  "online",
  "busy",
  "away",
  "snooze",
  "looking to trade",
  "looking to play",
];

export function summarizePlayer(r: PlayerSummariesResponse): Record<string, unknown> {
  const p = r.response?.players?.[0];
  if (!p) return { found: false };
  return {
    found: true,
    steamid: p.steamid,
    name: p.personaname ?? null,
    real_name: p.realname || null,
    state: PERSONA_STATES[p.personastate ?? 0] ?? "offline",
    visibility: p.communityvisibilitystate === 3 ? "public" : "private",
    country: p.loccountrycode || null,
    created: p.timecreated ? new Date(p.timecreated * 1000).toISOString().slice(0, 10) : null,
    in_game: p.gameextrainfo || null,
    profile_url: p.profileurl ?? null,
    avatar: p.avatarfull ?? null,
  };
}

// ---- Web API: owned / recently played ---------------------------------------

interface OwnedGame {
  appid?: number;
  name?: string;
  playtime_forever?: number;
  playtime_2weeks?: number;
  img_icon_url?: string;
}
export interface OwnedGamesResponse {
  response?: { game_count?: number; games?: OwnedGame[] };
}

// Steam returns an empty `response: {}` (no game_count) when the profile or its
// game-details are private — distinct from a public account with 0 games.
const PRIVATE_REASON =
  "Profile or game-details are private. Ask the owner to set Steam → Privacy → " +
  "Game details = Public, or this data can't be read.";

function isPrivate(r: OwnedGamesResponse): boolean {
  return r.response?.game_count === undefined && r.response?.games === undefined;
}

// Sort by playtime desc and cap; a big library would otherwise blow the budget.
export function summarizeOwnedGames(r: OwnedGamesResponse, max = 50): Record<string, unknown> {
  if (isPrivate(r)) return { found: false, reason: PRIVATE_REASON, game_count: null, games: [] };
  const games = (r.response?.games ?? [])
    .slice()
    .sort((a, b) => (b.playtime_forever ?? 0) - (a.playtime_forever ?? 0));
  return {
    found: true,
    game_count: r.response?.game_count ?? games.length,
    returned: Math.min(games.length, max),
    games: games.slice(0, max).map((g) => ({
      appid: g.appid,
      name: g.name ?? null,
      playtime_hours: hours(g.playtime_forever),
      playtime_2weeks_hours: hours(g.playtime_2weeks),
    })),
  };
}

export function summarizeRecentlyPlayed(r: OwnedGamesResponse): Record<string, unknown> {
  if (isPrivate(r)) return { found: false, reason: PRIVATE_REASON, total: 0, games: [] };
  return {
    found: true,
    total: r.response?.game_count ?? r.response?.games?.length ?? 0,
    games: (r.response?.games ?? []).map((g) => ({
      appid: g.appid,
      name: g.name ?? null,
      playtime_2weeks_hours: hours(g.playtime_2weeks),
      playtime_hours: hours(g.playtime_forever),
    })),
  };
}

// ---- Web API: player achievements -------------------------------------------

export interface PlayerAchievementsResponse {
  playerstats?: {
    success?: boolean;
    error?: string;
    gameName?: string;
    achievements?: { apiname?: string; name?: string; achieved?: number; unlocktime?: number }[];
  };
}

export function summarizePlayerAchievements(
  r: PlayerAchievementsResponse,
): Record<string, unknown> {
  const ps = r.playerstats;
  if (!ps?.success) return { found: false, reason: ps?.error ?? "No achievement stats" };
  const all = ps.achievements ?? [];
  const unlocked = all.filter((a) => a.achieved === 1);
  return {
    found: true,
    game: ps.gameName ?? null,
    total: all.length,
    unlocked: unlocked.length,
    completion_pct: all.length ? Math.round((unlocked.length / all.length) * 100) : null,
    achievements: all.map((a) => ({
      name: a.name || a.apiname,
      achieved: a.achieved === 1,
      unlocked_at:
        a.achieved === 1 && a.unlocktime
          ? new Date(a.unlocktime * 1000).toISOString().slice(0, 10)
          : null,
    })),
  };
}

// ---- Web API: global achievement percentages --------------------------------

export interface GlobalAchievementsResponse {
  achievementpercentages?: { achievements?: { name?: string; percent?: number | string }[] };
}

export function summarizeGlobalAchievements(
  r: GlobalAchievementsResponse,
): Record<string, unknown> {
  const a = r.achievementpercentages?.achievements ?? [];
  return {
    count: a.length,
    achievements: a.map((x) => ({
      name: x.name,
      percent: typeof x.percent === "string" ? Number(x.percent) : (x.percent ?? null),
    })),
  };
}

// ---- Web API: full achievement schema (key) + global rarity merge -----------

export interface GameSchemaResponse {
  game?: {
    gameName?: string;
    availableGameStats?: {
      achievements?: {
        name?: string; // internal apiname
        displayName?: string;
        description?: string;
        hidden?: number;
        icon?: string;
      }[];
    };
  };
}

// Merge the full schema (names/descriptions/hidden) with global unlock % (keyed
// by the internal apiname), so each achievement carries how rare it is.
export function summarizeGameSchema(
  schema: GameSchemaResponse,
  global: GlobalAchievementsResponse,
): Record<string, unknown> {
  const pct = new Map<string, number>();
  for (const x of global.achievementpercentages?.achievements ?? []) {
    if (x.name != null) {
      pct.set(x.name, typeof x.percent === "string" ? Number(x.percent) : (x.percent ?? 0));
    }
  }
  const list = schema.game?.availableGameStats?.achievements ?? [];
  return {
    game: schema.game?.gameName ?? null,
    total: list.length,
    achievements: list.map((a) => {
      const p = a.name != null ? pct.get(a.name) : undefined;
      return {
        api_name: a.name,
        name: a.displayName || a.name || null,
        description: a.description || null,
        hidden: a.hidden === 1,
        global_unlock_pct: typeof p === "number" ? Math.round(p * 10) / 10 : null,
      };
    }),
  };
}

// ---- Web API: news ----------------------------------------------------------

export interface NewsResponse {
  appnews?: {
    newsitems?: {
      gid?: string;
      title?: string;
      url?: string;
      author?: string;
      contents?: string;
      feedlabel?: string;
      date?: number;
    }[];
  };
}

export function summarizeNews(r: NewsResponse): Record<string, unknown> {
  return {
    items: (r.appnews?.newsitems ?? []).map((n) => ({
      title: n.title ?? null,
      date: n.date ? new Date(n.date * 1000).toISOString().slice(0, 10) : null,
      author: n.author || null,
      feed: n.feedlabel || null,
      excerpt: stripHtml(n.contents),
      url: n.url ?? null,
    })),
  };
}

// ---- Web API: resolve vanity url --------------------------------------------

export interface VanityResponse {
  response?: { success?: number; steamid?: string; message?: string };
}

export function summarizeVanity(r: VanityResponse): Record<string, unknown> {
  const v = r.response;
  if (v?.success === 1 && v.steamid) return { found: true, steamid: v.steamid };
  return { found: false, reason: v?.message ?? "No match for that vanity name" };
}

// ---- Web API: current players (keyless) -------------------------------------

export interface CurrentPlayersResponse {
  response?: { player_count?: number; result?: number };
}

export function summarizeCurrentPlayers(
  r: CurrentPlayersResponse,
  appid: number,
): Record<string, unknown> {
  return { appid, player_count: r.response?.player_count ?? null };
}

// ---- Web API: wishlist (keyless; needs a public wishlist) -------------------

export interface WishlistResponse {
  response?: { items?: { appid?: number; priority?: number; date_added?: number }[] };
}

// A wishlist can hold tens of thousands of items; sort by priority (1 = top of
// the list) and cap. Names aren't included — use get_game per appid for details.
export function summarizeWishlist(r: WishlistResponse, max = 100): Record<string, unknown> {
  const items = r.response?.items ?? [];
  if (items.length === 0) {
    return {
      found: false,
      reason: "Empty wishlist, or the profile/wishlist is private.",
      total: 0,
      items: [],
    };
  }
  const sorted = items.slice().sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9));
  return {
    found: true,
    total: items.length,
    returned: Math.min(items.length, max),
    items: sorted.slice(0, max).map((i) => ({
      appid: i.appid,
      priority: i.priority ?? null,
      added: isoDay(i.date_added),
    })),
  };
}

// ---- IStoreBrowseService/GetItems (keyless batch store data) ----------------

interface StoreItem {
  appid?: number;
  name?: string;
  is_free?: boolean;
  best_purchase_option?: {
    formatted_final_price?: string;
    formatted_original_price?: string;
    discount_pct?: number;
  };
  reviews?: {
    summary_filtered?: {
      review_count?: number;
      percent_positive?: number;
      review_score_label?: string;
    };
  };
  release?: { steam_release_date?: number; is_coming_soon?: boolean };
  // Valve's deck compatibility enum (returned with include_platforms): see DECK_COMPAT.
  platforms?: { windows?: boolean; mac?: boolean; steam_deck_compat_category?: number };
  visible?: boolean;
}
export interface StoreItemsResponse {
  response?: { store_items?: StoreItem[] };
}

// Steam Deck compatibility — Valve's enum on platforms.steam_deck_compat_category.
const DECK_COMPAT: Record<number, string> = {
  0: "unknown",
  1: "unsupported",
  2: "playable",
  3: "verified",
};
function steamDeck(cat?: number): string {
  return DECK_COMPAT[cat ?? 0] ?? "unknown";
}
// Map a user-facing deck filter to the minimum acceptable category: "verified"
// keeps only Verified; "playable" keeps Playable or Verified (i.e. "runs on Deck").
export const DECK_MIN: Record<string, number> = { verified: 3, playable: 2 };

// Compact card from a store item (shared by get_items and discover_games).
function storeCard(it: StoreItem): Record<string, unknown> {
  const bp = it.best_purchase_option;
  const rev = it.reviews?.summary_filtered;
  return {
    appid: it.appid,
    name: it.name ?? null,
    discount_pct: bp?.discount_pct ?? 0,
    price: bp?.formatted_final_price || null,
    original: bp?.formatted_original_price || bp?.formatted_final_price || null,
    review_percent: rev?.percent_positive ?? null,
    review_count: rev?.review_count ?? null,
    review_label: rev?.review_score_label ?? null,
    steam_deck: steamDeck(it.platforms?.steam_deck_compat_category),
    release_date: it.release?.steam_release_date
      ? new Date(it.release.steam_release_date * 1000).toISOString().slice(0, 10)
      : null,
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
  opts: { minReview?: number; minReviews?: number; steamDeck?: string; releasedAfter?: number },
): Record<string, unknown> {
  const deckMin = opts.steamDeck ? DECK_MIN[opts.steamDeck] : undefined;
  let rows = (r.response?.store_items ?? [])
    .filter((it) => {
      if (it.visible === false || typeof it.appid !== "number") return false;
      // Deck filter runs on the raw category (the Query API can't filter on it).
      if (deckMin !== undefined && (it.platforms?.steam_deck_compat_category ?? 0) < deckMin)
        return false;
      // Recency filter (the Query API has no release-date sort/filter): keep only
      // items released on/after the cutoff; drop ones with no known release date.
      if (
        opts.releasedAfter !== undefined &&
        (it.release?.steam_release_date ?? 0) < opts.releasedAfter
      )
        return false;
      return true;
    })
    .map(storeCard);
  if (typeof opts.minReview === "number") {
    rows = rows.filter((x) => ((x.review_percent as number | null) ?? -1) >= opts.minReview!);
  }
  if (typeof opts.minReviews === "number") {
    rows = rows.filter((x) => ((x.review_count as number | null) ?? 0) >= opts.minReviews!);
  }
  rows.sort((a, b) => (b.discount_pct as number) - (a.discount_pct as number));
  return {
    total_matching: r.response?.metadata?.total_matching_records ?? null,
    returned: rows.length,
    deals: rows,
  };
}

// Batch store card per requested appid: price+discount, review %, release date —
// all from one keyless call. Missing appids come back available:false.
export function summarizeItems(r: StoreItemsResponse, appids: number[]): Record<string, unknown> {
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
      const rev = it.reviews?.summary_filtered;
      return {
        appid,
        name: it.name ?? null,
        is_free: it.is_free ?? false,
        price: bp
          ? {
              final: bp.formatted_final_price || null,
              original: bp.formatted_original_price || bp.formatted_final_price || null,
              discount_pct: bp.discount_pct ?? 0,
            }
          : it.is_free
            ? { is_free: true }
            : null,
        review_percent: rev?.percent_positive ?? null,
        review_count: rev?.review_count ?? null,
        review_label: rev?.review_score_label ?? null,
        steam_deck: steamDeck(it.platforms?.steam_deck_compat_category),
        release_date: it.release?.steam_release_date
          ? new Date(it.release.steam_release_date * 1000).toISOString().slice(0, 10)
          : null,
        coming_soon: it.release?.is_coming_soon ?? false,
      };
    }),
  };
}
