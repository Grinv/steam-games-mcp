// Trims verbose official Steam Web API payloads (api.steampowered.com) down to the
// fields an agent needs: player profiles/library/achievements, game news,
// achievement rarity and the (light) wishlist. The keyless store-service
// formatters (GetItems/Query/tags/enriched wishlist) live in ./store.ts.
// Companion to ./storefront.ts and ./shared.ts.
//
// Every exported summarizer builds its return value via a matching `.strict()`
// zod schema's `.parse({...})` (see web.schemas.ts) instead of a bare object
// literal — the schema is the single source of truth for the shape (see
// storefront.ts's header comment for the full rationale).

import { z } from "zod";
import { hours, isoDay, storeUrl, stripHtml } from "./shared.js";
import { notFoundReason, wishlistNotFound } from "./shared.schemas.js";
import {
  comparePlayersFound,
  findFriendsWhoOwnFound,
  friendListFound,
  getCurrentPlayersOutput,
  getFollowedGamesOutput,
  getGameAchievementsOutput,
  getGameNewsOutput,
  getGlobalAchievementsOutput,
  getOwnedGamesOutput,
  getPlayerBansOutput,
  getPlayerSummaryOutput,
  getRecentlyPlayedOutput,
  playerAchievementsFound,
  vanityFound,
  wishlistLightFound,
} from "./web.schemas.js";

// ---- Web API: player summary ------------------------------------------------

export interface PlayerSummary {
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

// GetSteamLevel is fetched alongside GetPlayerSummaries and merged in; it has
// its own failure mode (e.g. private inventory), so the level is nullable
// independent of whether the summary itself was found.
export interface SteamLevelResponse {
  response?: { player_level?: number };
}

export function summarizePlayer(
  r: PlayerSummariesResponse,
  level?: number | null,
): z.infer<typeof getPlayerSummaryOutput> {
  const p = r.response?.players?.[0];
  if (!p) return getPlayerSummaryOutput.parse({ found: false });
  return getPlayerSummaryOutput.parse({
    found: true,
    steamid: p.steamid,
    name: p.personaname ?? null,
    real_name: p.realname || null,
    state: PERSONA_STATES[p.personastate ?? 0] ?? "offline",
    visibility: p.communityvisibilitystate === 3 ? "public" : "private",
    country: p.loccountrycode || null,
    level: level ?? null,
    created: isoDay(p.timecreated),
    in_game: p.gameextrainfo || null,
    profile_url: p.profileurl ?? null,
    avatar: p.avatarfull ?? null,
  });
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

// `games` is sorted by playtime desc and capped (a big library would otherwise
// blow the budget), so it's NOT reliable for "does this player own game X" —
// pass checkAppids to check specific appids against the FULL, uncapped list
// instead; `owns` then answers that reliably regardless of the games cap.
export function summarizeOwnedGames(
  r: OwnedGamesResponse,
  opts: { max?: number; checkAppids?: number[] } = {},
): z.infer<typeof getOwnedGamesOutput> {
  if (isPrivate(r)) {
    // No `owns` here even if checkAppids was given: a private profile means
    // ownership is genuinely unknown, not false — reporting owned:false would
    // misrepresent "can't check" as "doesn't own it".
    return getOwnedGamesOutput.parse({
      found: false,
      reason: PRIVATE_REASON,
      game_count: null,
      games: [],
    });
  }
  const all = r.response?.games ?? [];
  const games = all.slice().sort((a, b) => (b.playtime_forever ?? 0) - (a.playtime_forever ?? 0));
  const max = opts.max ?? 50;
  const byAppid = new Map(
    all
      .filter((g): g is OwnedGame & { appid: number } => typeof g.appid === "number")
      .map((g) => [g.appid, g]),
  );
  return getOwnedGamesOutput.parse({
    found: true,
    game_count: r.response?.game_count ?? games.length,
    returned: Math.min(games.length, max),
    games: games.slice(0, max).map((g) => ({
      appid: g.appid,
      name: g.name ?? null,
      playtime_hours: hours(g.playtime_forever),
      playtime_2weeks_hours: hours(g.playtime_2weeks),
    })),
    ...(opts.checkAppids && {
      owns: opts.checkAppids.map((appid) => {
        const g = byAppid.get(appid);
        return {
          appid,
          owned: g !== undefined,
          playtime_hours: g ? hours(g.playtime_forever) : null,
        };
      }),
    }),
  });
}

const COMPARE_PRIVATE_REASON =
  "One or both profiles/game-details are private. Ask the owner(s) to set Steam → " +
  "Privacy → Game details = Public.";

// Shared games between two players' FULL libraries (not capped like
// summarizeOwnedGames — comparing needs the whole list, not just the top N by
// playtime), each with its own playtime. Sorted by combined playtime desc.
export function summarizeComparePlayers(
  a: OwnedGamesResponse,
  b: OwnedGamesResponse,
  max = 50,
): z.infer<typeof notFoundReason> | z.infer<typeof comparePlayersFound> {
  if (isPrivate(a) || isPrivate(b)) {
    return notFoundReason.parse({ found: false, reason: COMPARE_PRIVATE_REASON });
  }
  const gamesA = new Map((a.response?.games ?? []).map((g) => [g.appid, g]));
  const gamesB = new Map((b.response?.games ?? []).map((g) => [g.appid, g]));
  const shared = [...gamesA.keys()]
    .filter((appid): appid is number => typeof appid === "number" && gamesB.has(appid))
    .map((appid) => {
      const ga = gamesA.get(appid)!;
      const gb = gamesB.get(appid)!;
      return {
        appid,
        name: ga.name ?? gb.name ?? null,
        playtime_hours_a: hours(ga.playtime_forever),
        playtime_hours_b: hours(gb.playtime_forever),
      };
    })
    .sort(
      (x, y) =>
        (y.playtime_hours_a ?? 0) +
        (y.playtime_hours_b ?? 0) -
        ((x.playtime_hours_a ?? 0) + (x.playtime_hours_b ?? 0)),
    );
  return comparePlayersFound.parse({
    found: true,
    shared_count: shared.length,
    returned: Math.min(shared.length, max),
    games: shared.slice(0, max),
  });
}

export function summarizeRecentlyPlayed(
  r: OwnedGamesResponse,
): z.infer<typeof getRecentlyPlayedOutput> {
  if (isPrivate(r)) {
    return getRecentlyPlayedOutput.parse({
      found: false,
      reason: PRIVATE_REASON,
      total: 0,
      games: [],
    });
  }
  return getRecentlyPlayedOutput.parse({
    found: true,
    total: r.response?.game_count ?? r.response?.games?.length ?? 0,
    games: (r.response?.games ?? []).map((g) => ({
      appid: g.appid,
      name: g.name ?? null,
      playtime_2weeks_hours: hours(g.playtime_2weeks),
      playtime_hours: hours(g.playtime_forever),
    })),
  });
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
): z.infer<typeof notFoundReason> | z.infer<typeof playerAchievementsFound> {
  const ps = r.playerstats;
  if (!ps?.success) {
    return notFoundReason.parse({ found: false, reason: ps?.error ?? "No achievement stats" });
  }
  const all = ps.achievements ?? [];
  const unlocked = all.filter((a) => a.achieved === 1);
  return playerAchievementsFound.parse({
    found: true,
    game: ps.gameName ?? null,
    total: all.length,
    unlocked: unlocked.length,
    completion_pct: all.length ? Math.round((unlocked.length / all.length) * 100) : null,
    achievements: all.map((a) => ({
      name: a.name || a.apiname,
      achieved: a.achieved === 1,
      unlocked_at: a.achieved === 1 ? isoDay(a.unlocktime) : null,
    })),
  });
}

// ---- Web API: global achievement percentages --------------------------------

export interface GlobalAchievementsResponse {
  achievementpercentages?: { achievements?: { name?: string; percent?: number | string }[] };
}

export function summarizeGlobalAchievements(
  r: GlobalAchievementsResponse,
): z.infer<typeof getGlobalAchievementsOutput> {
  const a = r.achievementpercentages?.achievements ?? [];
  return getGlobalAchievementsOutput.parse({
    count: a.length,
    achievements: a.map((x) => ({
      name: x.name,
      percent: typeof x.percent === "string" ? Number(x.percent) : (x.percent ?? null),
    })),
  });
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
): z.infer<typeof getGameAchievementsOutput> {
  const pct = new Map<string, number>();
  for (const x of global.achievementpercentages?.achievements ?? []) {
    if (x.name != null) {
      pct.set(x.name, typeof x.percent === "string" ? Number(x.percent) : (x.percent ?? 0));
    }
  }
  const list = schema.game?.availableGameStats?.achievements ?? [];
  return getGameAchievementsOutput.parse({
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
  });
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

export function summarizeNews(r: NewsResponse): z.infer<typeof getGameNewsOutput> {
  return getGameNewsOutput.parse({
    items: (r.appnews?.newsitems ?? []).map((n) => ({
      title: n.title ?? null,
      date: isoDay(n.date),
      author: n.author || null,
      feed: n.feedlabel || null,
      excerpt: stripHtml(n.contents),
      url: n.url ?? null,
    })),
  });
}

// ---- Web API: resolve vanity url --------------------------------------------

export interface VanityResponse {
  response?: { success?: number; steamid?: string; message?: string };
}

export function summarizeVanity(
  r: VanityResponse,
): z.infer<typeof vanityFound> | z.infer<typeof notFoundReason> {
  const v = r.response;
  if (v?.success === 1 && v.steamid) return vanityFound.parse({ found: true, steamid: v.steamid });
  return notFoundReason.parse({
    found: false,
    reason: v?.message ?? "No match for that vanity name",
  });
}

// ---- Web API: current players (keyless) -------------------------------------

export interface CurrentPlayersResponse {
  response?: { player_count?: number; result?: number };
}

export function summarizeCurrentPlayers(
  r: CurrentPlayersResponse,
  appid: number,
): z.infer<typeof getCurrentPlayersOutput> {
  return getCurrentPlayersOutput.parse({ appid, player_count: r.response?.player_count ?? null });
}

// ---- Web API: wishlist (keyless; needs a public wishlist) -------------------

export interface WishlistResponse {
  response?: { items?: { appid?: number; priority?: number; date_added?: number }[] };
}

// A wishlist can hold tens of thousands of items; sort by priority (1 = top of
// the list) and cap. Names aren't included — use get_game per appid for details.
export function summarizeWishlist(
  r: WishlistResponse,
  max = 100,
): z.infer<typeof wishlistNotFound> | z.infer<typeof wishlistLightFound> {
  const items = r.response?.items ?? [];
  if (items.length === 0) {
    return wishlistNotFound.parse({
      found: false,
      reason: "Empty wishlist, or the profile/wishlist is private.",
      total: 0,
      items: [],
    });
  }
  const sorted = items.toSorted((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9));
  return wishlistLightFound.parse({
    found: true,
    total: items.length,
    returned: Math.min(items.length, max),
    items: sorted.slice(0, max).map((i) => ({
      appid: i.appid,
      store_url: storeUrl(i.appid),
      priority: i.priority ?? null,
      added: isoDay(i.date_added),
    })),
  });
}

// ---- Web API: player bans (key required; ban status is always public) ------

export interface PlayerBansResponse {
  players?: {
    SteamId?: string;
    CommunityBanned?: boolean;
    VACBanned?: boolean;
    NumberOfVACBans?: number;
    NumberOfGameBans?: number;
    DaysSinceLastBan?: number;
    EconomyBan?: string;
  }[];
}

export function summarizePlayerBans(r: PlayerBansResponse): z.infer<typeof getPlayerBansOutput> {
  const p = r.players?.[0];
  if (!p) return getPlayerBansOutput.parse({ found: false });
  return getPlayerBansOutput.parse({
    found: true,
    steamid: p.SteamId,
    vac_banned: p.VACBanned ?? false,
    vac_ban_count: p.NumberOfVACBans ?? 0,
    game_ban_count: p.NumberOfGameBans ?? 0,
    community_banned: p.CommunityBanned ?? false,
    economy_ban: p.EconomyBan && p.EconomyBan !== "none" ? p.EconomyBan : null,
    days_since_last_ban: p.DaysSinceLastBan ?? null,
  });
}

// ---- Web API: followed games (keyless; needs a public profile) -------------

export interface FollowedGamesResponse {
  response?: { appids?: number[] };
}
export interface FollowedGamesCountResponse {
  response?: { followed_game_count?: number };
}

// A player can follow far more games than they wishlist; cap like the other
// list tools. total comes from the dedicated count endpoint (independent of
// any cap on the appid list), same pattern as summarizeWishlist.
const FOLLOWED_MAX = 200;
export function summarizeFollowedGames(
  r: FollowedGamesResponse,
  countRes: FollowedGamesCountResponse,
  max = FOLLOWED_MAX,
): z.infer<typeof getFollowedGamesOutput> {
  const appids = r.response?.appids ?? [];
  if (appids.length === 0) {
    return getFollowedGamesOutput.parse({
      found: false,
      reason: "No followed games, or the profile is private.",
      total: 0,
      games: [],
    });
  }
  return getFollowedGamesOutput.parse({
    found: true,
    total: countRes.response?.followed_game_count ?? appids.length,
    returned: Math.min(appids.length, max),
    games: appids.slice(0, max).map((appid) => ({ appid, store_url: storeUrl(appid) })),
  });
}

// ---- Web API: friend list (key required; friends list must be public) ------

export interface FriendListResponse {
  friendslist?: { friends?: { steamid?: string; relationship?: string; friend_since?: number }[] };
}

// GetFriendList only returns steamid/friend_since — no names — so this merges
// in a GetPlayerSummaries batch (fetched alongside) for name/state/avatar.
// Sorted most-recent-friend-first, capped like the other list tools.
export function summarizeFriendList(
  r: FriendListResponse,
  players: PlayerSummariesResponse,
  max = 100,
): z.infer<typeof friendListFound> {
  const friends = r.friendslist?.friends ?? [];
  if (friends.length === 0) {
    return friendListFound.parse({ found: true, total: 0, returned: 0, friends: [] });
  }
  const byId = new Map<string, PlayerSummary>();
  for (const p of players.response?.players ?? []) if (p.steamid) byId.set(p.steamid, p);
  const sorted = friends.toSorted((a, b) => (b.friend_since ?? 0) - (a.friend_since ?? 0));
  return friendListFound.parse({
    found: true,
    total: friends.length,
    returned: Math.min(friends.length, max),
    friends: sorted.slice(0, max).map((f) => {
      const p = f.steamid ? byId.get(f.steamid) : undefined;
      return {
        steamid: f.steamid,
        name: p?.personaname ?? null,
        state: PERSONA_STATES[p?.personastate ?? 0] ?? "offline",
        in_game: p?.gameextrainfo || null,
        profile_url: p?.profileurl ?? null,
        friends_since: isoDay(f.friend_since),
      };
    }),
  });
}

// ---- Web API: find friends who own a game (key required) -------------------

// Per appid, which friends own it, plus two reasons a friend can be missing
// from that count instead of a confirmed non-owner: private_friends (their
// library is private — #ownedPlaytimes' own null) and unavailable_friends
// (their individual GetOwnedGames call failed — rate-limited/network/
// timeout/5xx, from findFriendsWhoOwn's Promise.allSettled over all friends).
// Both are kept separate from "doesn't own" so an agent never reports either
// case as a confirmed non-owner, and separate from each other since only one
// of them (unavailable) is worth a retry.
export function summarizeFriendsWhoOwn(
  appids: number[],
  friendIds: string[],
  ownership: (Map<number, number> | null | { error: string })[],
  players: PlayerSummariesResponse,
): z.infer<typeof findFriendsWhoOwnFound> {
  const byId = new Map<string, PlayerSummary>();
  for (const p of players.response?.players ?? []) if (p.steamid) byId.set(p.steamid, p);
  const nameOf = (steamid: string) => ({ steamid, name: byId.get(steamid)?.personaname ?? null });

  const owners = new Map<number, ({ playtime_hours: number | null } & ReturnType<typeof nameOf>)[]>(
    appids.map((a) => [a, []]),
  );
  const privateFriends: ReturnType<typeof nameOf>[] = [];
  const unavailableFriends: (ReturnType<typeof nameOf> & { reason: string })[] = [];
  friendIds.forEach((steamid, i) => {
    const playtimes = ownership[i];
    if (playtimes === null) {
      privateFriends.push(nameOf(steamid));
      return;
    }
    if (!(playtimes instanceof Map)) {
      // ownership is always the same length as friendIds (one entry per id,
      // via Promise.allSettled over that same list) — `undefined` here would
      // mean that invariant broke, not a real per-friend failure.
      unavailableFriends.push({
        ...nameOf(steamid),
        reason: playtimes?.error ?? "no data returned",
      });
      return;
    }
    for (const appid of appids) {
      if (!playtimes.has(appid)) continue;
      owners.get(appid)!.push({ ...nameOf(steamid), playtime_hours: hours(playtimes.get(appid)) });
    }
  });

  return findFriendsWhoOwnFound.parse({
    found: true,
    total_friends: friendIds.length,
    matches: appids.map((appid) => ({ appid, owners: owners.get(appid) ?? [] })),
    private_friends: privateFriends,
    unavailable_friends: unavailableFriends,
  });
}
