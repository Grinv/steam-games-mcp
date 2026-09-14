// Trims verbose official Steam Web API payloads (api.steampowered.com) down to the
// fields an agent needs: player profiles/library/achievements, game news,
// achievement rarity and the (light) wishlist. The keyless store-service
// formatters (GetItems/Query/tags/enriched wishlist) live in ./store.ts.
// Companion to ./storefront.ts and ./shared.ts.
//
// Every exported summarizer builds its return value via a matching `z.strictObject()`
// zod schema's `.parse({...})` (see web.schemas.ts) instead of a bare object
// literal — the schema is the single source of truth for the shape (see
// storefront.ts's header comment for the full rationale).

import { z } from "zod";
import {
  NO_SUCH_ACCOUNT_REASON,
  PRIVATE_PROFILE_REASON,
  capList,
  hours,
  isoDay,
  notFound,
  storeUrl,
  stripHtml,
} from "./shared.js";
import { notFoundReason, wishlistNotFound } from "./shared.schemas.js";
import {
  comparePlayersFound,
  findFriendsWhoOwnFound,
  friendListFound,
  getCurrentPlayersOutput,
  getFollowedGamesOutput,
  getGameNewsOutput,
  getOwnedGamesOutput,
  getPlayerBansOutput,
  getPlayerSummaryOutput,
  getRecentlyPlayedOutput,
  personaStates,
  vanityFound,
  visibilitySchema,
  wishlistLightFound,
} from "./web.schemas.js";

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

// GetSteamLevel is fetched alongside GetPlayerSummaries and merged in; it has
// its own failure mode (e.g. private inventory), so the level is nullable
// independent of whether the summary itself was found.
export interface SteamLevelResponse {
  response?: { player_level?: number };
}

// ECommunityVisibilityState. Without auth (which is how this server calls it),
// GetPlayerSummaries only ever returns 1 (not visible to us) or 3 (public) —
// the full 1-5 enum's finer friends/friends-of-friends states all collapse to
// "not visible" from an anonymous request's point of view, so 3 vs. not-3 is
// the only distinction the payload actually carries.
const VISIBILITY_PUBLIC = 3;

export function summarizePlayer(
  r: PlayerSummariesResponse,
  level?: number | null,
): z.infer<typeof getPlayerSummaryOutput> {
  const p = r.response?.players?.[0];
  if (!p) return getPlayerSummaryOutput.parse({ found: false, reason: NO_SUCH_ACCOUNT_REASON });
  return getPlayerSummaryOutput.parse({
    found: true,
    steamid: p.steamid,
    name: p.personaname ?? null,
    real_name: p.realname || null,
    state: personaStates[p.personastate ?? 0] ?? "offline",
    visibility:
      p.communityvisibilitystate === VISIBILITY_PUBLIC
        ? visibilitySchema.enum.public
        : visibilitySchema.enum.private,
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
// Exported because clients/web.ts hits the same GetOwnedGames shape twice before
// any summarizer runs, and had hand-inlined this condition at both sites.
// Strictly GetOwnedGames: its sibling GetRecentlyPlayedGames answers with its
// own `total_count` field instead, which is exactly the mix-up that once
// reported a public profile with no recent playtime as private.
export function isPrivateOwnedGames(r: OwnedGamesResponse): boolean {
  return r.response?.game_count === undefined && r.response?.games === undefined;
}

// `games` is sorted by playtime desc and capped (a big library would otherwise
// blow the budget), so it's NOT reliable for "does this player own game X" —
// pass checkAppids to check specific appids against the FULL, uncapped list
// instead; `owns` then answers that reliably regardless of the games cap.
//
// Exported like every other cap in this file: the number appears in four tool
// descriptions besides this one (three of them cross-referencing get_owned_games
// from another tool), so a bare literal meant changing it in six places.
export const OWNED_GAMES_MAX = 50;

// Which end of the library the cap keeps. Descending answers "what do I play";
// ascending answers "what have I never got round to", which the default order
// puts exactly where the cap discards it.
export type OwnedGamesSort = "playtime_desc" | "playtime_asc";

export function summarizeOwnedGames(
  r: OwnedGamesResponse,
  opts: { max?: number; checkAppids?: number[]; sort?: OwnedGamesSort } = {},
): z.infer<typeof getOwnedGamesOutput> {
  if (isPrivateOwnedGames(r)) {
    // No `owns` here even if checkAppids was given: a private profile means
    // ownership is genuinely unknown, not false — reporting owned:false would
    // misrepresent "can't check" as "doesn't own it".
    return getOwnedGamesOutput.parse({
      found: false,
      reason: PRIVATE_PROFILE_REASON,
      game_count: null,
      games: [],
    });
  }
  const all = r.response?.games ?? [];
  const direction = opts.sort === "playtime_asc" ? -1 : 1;
  const games = all
    .slice()
    .sort((a, b) => direction * ((b.playtime_forever ?? 0) - (a.playtime_forever ?? 0)));
  const max = opts.max ?? OWNED_GAMES_MAX;
  const byAppid = new Map(
    all
      .filter((g): g is OwnedGame & { appid: number } => typeof g.appid === "number")
      .map((g) => [g.appid, g]),
  );
  const { included, returned } = capList(games, max);
  return getOwnedGamesOutput.parse({
    found: true,
    game_count: r.response?.game_count ?? games.length,
    returned,
    games: included.map((g) => ({
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
export const COMPARE_SHARED_MAX = 50;
export function summarizeComparePlayers(
  a: OwnedGamesResponse,
  b: OwnedGamesResponse,
  max = COMPARE_SHARED_MAX,
): z.infer<typeof notFoundReason> | z.infer<typeof comparePlayersFound> {
  if (isPrivateOwnedGames(a) || isPrivateOwnedGames(b)) {
    return notFound(COMPARE_PRIVATE_REASON);
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
  const { included, returned } = capList(shared, max);
  return comparePlayersFound.parse({
    found: true,
    shared_count: shared.length,
    returned,
    games: included,
  });
}

// GetRecentlyPlayedGames uses its own count field (`total_count`), distinct
// from GetOwnedGames' `game_count` — a public profile with nothing played in
// the last 2 weeks answers `{total_count: 0}` with no `games` array, which
// isPrivate()'s `game_count`/`games` check would misreport as private since
// neither of ITS fields is ever present in this endpoint's response at all.
export interface RecentlyPlayedResponse {
  response?: { total_count?: number; games?: OwnedGame[] };
}

function isPrivateRecentlyPlayed(r: RecentlyPlayedResponse): boolean {
  return r.response?.total_count === undefined && r.response?.games === undefined;
}

export const RECENTLY_PLAYED_MAX = 50;
export function summarizeRecentlyPlayed(
  r: RecentlyPlayedResponse,
  max = RECENTLY_PLAYED_MAX,
): z.infer<typeof getRecentlyPlayedOutput> {
  if (isPrivateRecentlyPlayed(r)) {
    return getRecentlyPlayedOutput.parse({
      found: false,
      reason: PRIVATE_PROFILE_REASON,
      total: 0,
      games: [],
    });
  }
  // The two-week window keeps this list short in practice, but "in practice" is
  // not a bound — it was the one collection summarizer with neither a cap nor a
  // `returned` count, against AGENTS.md's trim-every-list rule. Sorted so the
  // cap keeps the games actually played most, not an arbitrary slice.
  const all = (r.response?.games ?? []).toSorted(
    (a, b) => (b.playtime_2weeks ?? 0) - (a.playtime_2weeks ?? 0),
  );
  const { included, returned } = capList(all, max);
  return getRecentlyPlayedOutput.parse({
    found: true,
    total: r.response?.total_count ?? all.length,
    returned,
    games: included.map((g) => ({
      appid: g.appid,
      name: g.name ?? null,
      playtime_2weeks_hours: hours(g.playtime_2weeks),
      playtime_hours: hours(g.playtime_forever),
    })),
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

// EResult.OK. ResolveVanityURL reports EResult in `response.success`: 1 (OK) on
// a hit, 42 (EResult.NoMatch) when the name resolves to nothing — so
// success === RESULT_OK is the only "found" case.
export const RESULT_OK = 1;

export function summarizeVanity(
  r: VanityResponse,
): z.infer<typeof vanityFound> | z.infer<typeof notFoundReason> {
  const v = r.response;
  if (v?.success === RESULT_OK && v.steamid)
    return vanityFound.parse({ found: true, steamid: v.steamid });
  return notFound(v?.message ?? "No match for that vanity name");
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
export const WISHLIST_LIGHT_MAX = 100;
export function summarizeWishlist(
  r: WishlistResponse,
  max = WISHLIST_LIGHT_MAX,
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
  const { included, returned } = capList(sorted, max);
  return wishlistLightFound.parse({
    found: true,
    total: items.length,
    returned,
    items: included.map((i) => ({
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
  if (!p) return getPlayerBansOutput.parse({ found: false, reason: NO_SUCH_ACCOUNT_REASON });
  const vacBanned = p.VACBanned ?? false;
  const vacBanCount = p.NumberOfVACBans ?? 0;
  const gameBanCount = p.NumberOfGameBans ?? 0;
  const communityBanned = p.CommunityBanned ?? false;
  const economyBan = p.EconomyBan && p.EconomyBan !== "none" ? p.EconomyBan : null;
  // Steam returns DaysSinceLastBan: 0 for players who have NEVER been banned,
  // which reads as "banned today". Only surface it when a ban actually exists.
  const everBanned =
    vacBanned || vacBanCount > 0 || gameBanCount > 0 || communityBanned || economyBan !== null;
  return getPlayerBansOutput.parse({
    found: true,
    steamid: p.SteamId,
    vac_banned: vacBanned,
    vac_ban_count: vacBanCount,
    game_ban_count: gameBanCount,
    community_banned: communityBanned,
    economy_ban: economyBan,
    days_since_last_ban: everBanned ? (p.DaysSinceLastBan ?? null) : null,
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
export const FOLLOWED_MAX = 200;
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
  const { included, returned } = capList(appids, max);
  return getFollowedGamesOutput.parse({
    found: true,
    total: countRes.response?.followed_game_count ?? appids.length,
    returned,
    games: included.map((appid) => ({ appid, store_url: storeUrl(appid) })),
  });
}

// ---- Web API: friend list (key required; friends list must be public) ------

export interface FriendListResponse {
  friendslist?: { friends?: { steamid?: string; relationship?: string; friend_since?: number }[] };
}

// GetFriendList only returns steamid/friend_since — no names — so this merges
// in a GetPlayerSummaries batch (fetched alongside) for name/state/avatar.
// Sorted most-recent-friend-first, capped like the other list tools.
export const FRIENDS_MAX = 100;

// The steamids summarizeFriendList will actually return — same most-recent-first
// sort, same cap. getFriendList enriches only these: a 2000-friend account
// otherwise spent 20 chunked GetPlayerSummaries round-trips to populate a
// 100-entry list and threw 19 of them away. Lives here, next to the sort it
// mirrors, so the two can't drift apart.
export function friendIdsToEnrich(r: FriendListResponse, max = FRIENDS_MAX): string[] {
  return sortedFriends(r)
    .slice(0, max)
    .map((f) => f.steamid)
    .filter((id): id is string => Boolean(id));
}

function sortedFriends(r: FriendListResponse) {
  return (r.friendslist?.friends ?? []).toSorted(
    (a, b) => (b.friend_since ?? 0) - (a.friend_since ?? 0),
  );
}

export function summarizeFriendList(
  r: FriendListResponse,
  players: PlayerSummariesResponse,
  max = FRIENDS_MAX,
): z.infer<typeof friendListFound> {
  const friends = r.friendslist?.friends ?? [];
  if (friends.length === 0) {
    return friendListFound.parse({ found: true, total: 0, returned: 0, friends: [] });
  }
  const byId = new Map<string, PlayerSummary>();
  for (const p of players.response?.players ?? []) if (p.steamid) byId.set(p.steamid, p);
  const { included, returned } = capList(sortedFriends(r), max);
  return friendListFound.parse({
    found: true,
    total: friends.length,
    returned,
    friends: included.map((f) => {
      const p = f.steamid ? byId.get(f.steamid) : undefined;
      return {
        steamid: f.steamid,
        name: p?.personaname ?? null,
        state: personaStates[p?.personastate ?? 0] ?? "offline",
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
export const FRIENDS_WHO_OWN_MAX = 100;

// How many friends get looked up at all. One GetOwnedGames call per friend is
// unavoidable here, and a big account makes that a wall: measured live on a
// 634-friend profile, checking every friend takes longer than the 60s default
// request timeout an MCP client gives up at, so the whole call fails. Capping
// the lookups keeps the answer bounded and honest (`friends_checked` says how
// many were actually read) — and it is strictly better than the alternative
// that shipped through 0.12.2, where the unbounded fan-out rate-limited itself
// and reported 527 of those 634 friends as `unavailable`.
export const FRIENDS_CHECKED_MAX = 200;

export function summarizeFriendsWhoOwn(
  appids: number[],
  friendIds: string[],
  ownership: (Map<number, number> | null | { error: string })[],
  players: PlayerSummariesResponse,
  opts: { max?: number; totalFriends?: number } = {},
): z.infer<typeof findFriendsWhoOwnFound> {
  const max = opts.max ?? FRIENDS_WHO_OWN_MAX;
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

  const cappedPrivate = capList(privateFriends, max);
  const cappedUnavailable = capList(unavailableFriends, max);
  return findFriendsWhoOwnFound.parse({
    found: true,
    total_friends: opts.totalFriends ?? friendIds.length,
    friends_checked: friendIds.length,
    matches: appids.map((appid) => {
      const forAppid = owners.get(appid) ?? [];
      const { included, returned } = capList(forAppid, max);
      return {
        appid,
        owners: included,
        ...(returned < forAppid.length && { owners_total: forAppid.length }),
      };
    }),
    private_friends: cappedPrivate.included,
    ...(cappedPrivate.returned < privateFriends.length && {
      private_friends_total: privateFriends.length,
    }),
    unavailable_friends: cappedUnavailable.included,
    ...(cappedUnavailable.returned < unavailableFriends.length && {
      unavailable_friends_total: unavailableFriends.length,
    }),
  });
}
