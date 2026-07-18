// Read-only client for the official Steam Web API (api.steampowered.com).
// Valve states that all Web API use requires a free key
// (https://steamcommunity.com/dev/apikey), so player tools require STEAM_API_KEY.
// A couple of endpoints (news, global achievement %) currently also answer
// without a key; we send the key when present and let them work either way.
// Reference: https://developer.valvesoftware.com/wiki/Steam_Web_API
import { HttpClient } from "../lib/http.js";
import { RateLimiter } from "../lib/rateLimit.js";
import { TtlCache } from "../lib/cache.js";
import { ApiError } from "../lib/errors.js";
import {
  summarizeComparePlayers,
  summarizeCurrentPlayers,
  summarizeFollowedGames,
  summarizeFriendList,
  summarizeFriendsWhoOwn,
  summarizeGameSchema,
  summarizeGlobalAchievements,
  summarizeNews,
  summarizeOwnedGames,
  summarizePlayer,
  summarizePlayerAchievements,
  summarizePlayerBans,
  summarizeRecentlyPlayed,
  summarizeVanity,
  summarizeWishlist,
  type CurrentPlayersResponse,
  type FollowedGamesCountResponse,
  type FollowedGamesResponse,
  type FriendListResponse,
  type GameSchemaResponse,
  type GlobalAchievementsResponse,
  type NewsResponse,
  type OwnedGamesResponse,
  type PlayerAchievementsResponse,
  type PlayerBansResponse,
  type PlayerSummariesResponse,
  type SteamLevelResponse,
  type VanityResponse,
  type WishlistResponse,
} from "../format/web.js";
import { StoreServiceClient } from "./storeService.js";
import type { Logger } from "../lib/logger.js";
import type { Config } from "../config.js";

type Query = Record<string, string | number | boolean | undefined>;

const PRIVATE_PROFILE_REASON =
  "Profile or game-details are private. Ask the owner to set Steam → Privacy → " +
  "Game details = Public.";

const PRIVATE_FRIENDS_REASON =
  "Profile or friends list is private. Ask the owner to set Steam → Privacy → " +
  "Friends List = Public.";

function friendIdsOf(r: FriendListResponse): string[] {
  return (r.friendslist?.friends ?? [])
    .map((f) => f.steamid)
    .filter((id): id is string => Boolean(id));
}

export class SteamWebClient {
  readonly #http: HttpClient;
  readonly #cache: TtlCache;
  readonly #key: string | undefined;
  readonly #l: string;
  readonly #country: string;
  readonly #defaultSteamId: string | undefined;
  // The modern store-browse/query/wishlist-sorted services (get_items,
  // discover_games, get_wishlist's include_details) — see clients/storeService.ts.
  readonly #store: StoreServiceClient;
  // Memoised result of resolving a vanity STEAM_ID default to a SteamID64.
  #resolvedDefault: string | undefined;
  /** True when a Steam Web API key is configured; player tools short-circuit otherwise. */
  readonly configured: boolean;

  constructor(config: Config, logger: Logger) {
    this.#key = config.steamApiKey;
    this.#l = config.language;
    this.#country = config.country;
    this.#defaultSteamId = config.defaultSteamId;
    this.configured = Boolean(config.steamApiKey);
    const limiter = new RateLimiter(config.apiMinIntervalMs);
    this.#http = new HttpClient({
      baseUrl: config.steamApiBaseUrl,
      logger,
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      beforeRequest: () => limiter.acquire(),
    });
    this.#cache = new TtlCache(config.cacheTtlMs);
    // Shares this #http/#cache (one rate limiter, one cache) rather than owning
    // its own — both clients hit the same api.steampowered.com host.
    this.#store = new StoreServiceClient({
      get: this.#get.bind(this),
      cache: this.#cache,
      language: this.#l,
      country: this.#country,
    });
  }

  #get<T>(path: string, query: Query): Promise<T> {
    return this.#http.getJson<T>(path, { query: { key: this.#key, ...query } });
  }

  // Resolve the SteamID64 a player tool should act on: the explicit argument
  // wins; otherwise fall back to the configured STEAM_ID default (resolving a
  // vanity name once). Throws a clear ApiError when neither is available.
  async requireSteamId(explicit?: string): Promise<string> {
    if (explicit) return explicit;
    const raw = this.#defaultSteamId;
    if (!raw) {
      throw new ApiError({
        code: "bad_request",
        message:
          "no steamid was given and STEAM_ID is not set. Pass a 17-digit SteamID64, or set " +
          "STEAM_ID (a SteamID64 or vanity name) in the server config.",
      });
    }
    if (/^\d{17}$/.test(raw)) return raw;
    if (this.#resolvedDefault) return this.#resolvedDefault;
    if (!this.configured) {
      throw new ApiError({
        code: "bad_request",
        message:
          `STEAM_ID is a vanity name ("${raw}") which needs a Steam Web API key to resolve. ` +
          "Set STEAM_API_KEY, or set STEAM_ID to a 17-digit SteamID64 instead.",
      });
    }
    const res = await this.#get<VanityResponse>("ISteamUser/ResolveVanityURL/v1/", {
      vanityurl: raw,
    });
    const steamid = res.response?.steamid;
    if (res.response?.success !== 1 || !steamid) {
      throw new ApiError({
        code: "bad_request",
        message: `could not resolve the STEAM_ID vanity name "${raw}" to a SteamID64.`,
      });
    }
    this.#resolvedDefault = steamid;
    return steamid;
  }

  // ---- player data (key required) -------------------------------------------

  async getPlayerSummary(steamid: string): Promise<Record<string, unknown>> {
    const [res, level] = await Promise.all([
      this.#get<PlayerSummariesResponse>("ISteamUser/GetPlayerSummaries/v2/", {
        steamids: steamid,
      }),
      this.#steamLevel(steamid),
    ]);
    return summarizePlayer(res, level);
  }

  // GetSteamLevel has its own failure mode (independent of the summary lookup);
  // never let it turn a working get_player_summary call into an error. Cached
  // like the other small, semi-static enrichment fetches (#tagNames,
  // getGlobalAchievements) — same wrapStaleOnError so a transient failure falls
  // back to the last-known level instead of degrading to null every time.
  async #steamLevel(steamid: string): Promise<number | null> {
    try {
      const wrapped = await this.#cache.wrapStaleOnError(`level:${steamid}`, async () => {
        const res = await this.#get<SteamLevelResponse>("IPlayerService/GetSteamLevel/v1/", {
          steamid,
        });
        return { level: res.response?.player_level ?? null };
      });
      return wrapped.level;
    } catch {
      return null;
    }
  }

  async getPlayerBans(steamid: string): Promise<Record<string, unknown>> {
    const res = await this.#get<PlayerBansResponse>("ISteamUser/GetPlayerBans/v1/", {
      steamids: steamid,
    });
    return summarizePlayerBans(res);
  }

  async getOwnedGames(steamid: string, checkAppids?: number[]): Promise<Record<string, unknown>> {
    const res = await this.#get<OwnedGamesResponse>("IPlayerService/GetOwnedGames/v1/", {
      steamid,
      include_appinfo: true,
      include_played_free_games: true,
    });
    return summarizeOwnedGames(res, { checkAppids });
  }

  async getRecentlyPlayed(steamid: string): Promise<Record<string, unknown>> {
    const res = await this.#get<OwnedGamesResponse>("IPlayerService/GetRecentlyPlayedGames/v1/", {
      steamid,
    });
    return summarizeRecentlyPlayed(res);
  }

  // Personalized recommendations derived from the player's own library: tags
  // on their most-played games become weighted preferences, discounted by
  // review quality, then ranked against the broader catalog. Needs the key
  // for GetOwnedGames' playtime even though the catalog side (store) is keyless.
  async getRecommendedGames(
    steamid: string,
    opts: {
      count?: number;
      country?: string;
      language?: string;
      excludeTags?: string[];
      minDiscount?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const res = await this.#get<OwnedGamesResponse>("IPlayerService/GetOwnedGames/v1/", {
      steamid,
      include_appinfo: false,
      // Without this, Steam omits free-to-play games from the owned list
      // entirely — they'd then not only miss tag-weighting but, worse, never
      // get excluded as "already owned" and could be recommended back.
      include_played_free_games: true,
    });
    if (res.response?.games === undefined && res.response?.game_count === undefined) {
      return { found: false, reason: PRIVATE_PROFILE_REASON };
    }
    const games = (res.response?.games ?? [])
      .filter((g): g is { appid: number; playtime_forever?: number } => typeof g.appid === "number")
      .map((g) => ({ appid: g.appid, playtimeMinutes: g.playtime_forever ?? 0 }));
    return this.#store.getRecommendedGames(games, opts);
  }

  // Shared games between two players' FULL libraries, unlike get_owned_games
  // which caps to the top 50 by playtime — comparing needs the whole list.
  async comparePlayers(steamidA: string, steamidB: string): Promise<Record<string, unknown>> {
    const [a, b] = await Promise.all([
      this.#get<OwnedGamesResponse>("IPlayerService/GetOwnedGames/v1/", {
        steamid: steamidA,
        include_appinfo: true,
      }),
      this.#get<OwnedGamesResponse>("IPlayerService/GetOwnedGames/v1/", {
        steamid: steamidB,
        include_appinfo: true,
      }),
    ]);
    return summarizeComparePlayers(a, b);
  }

  async getPlayerAchievements(
    steamid: string,
    appid: number,
    language?: string,
  ): Promise<Record<string, unknown>> {
    const l = language ?? this.#l;
    try {
      const res = await this.#get<PlayerAchievementsResponse>(
        "ISteamUserStats/GetPlayerAchievements/v1/",
        { steamid, appid, l },
      );
      if (res.playerstats?.success) return summarizePlayerAchievements(res);
      // 200 but success:false — disambiguate private vs no-achievements.
      return this.#explainNoPlayerAchievements(appid, l, res.playerstats?.error);
    } catch (e) {
      // Steam answers 403 for a private profile, 400 for an app with no stats /
      // not owned. Turn both into a clear, actionable reason.
      if (e instanceof ApiError && (e.code === "forbidden" || e.code === "unauthorized")) {
        return { found: false, reason: PRIVATE_PROFILE_REASON };
      }
      if (e instanceof ApiError && (e.code === "bad_request" || e.code === "not_found")) {
        return this.#explainNoPlayerAchievements(appid, l);
      }
      throw e;
    }
  }

  // On failure, check the game's schema: if it HAS achievements the player data
  // is hidden (private/not owned); if it has none, the game simply has no
  // achievements. Only runs on the failure path, so the happy path stays 1 call.
  async #explainNoPlayerAchievements(
    appid: number,
    l: string,
    apiError?: string,
  ): Promise<Record<string, unknown>> {
    if (apiError && /not public|private/i.test(apiError)) {
      return { found: false, reason: PRIVATE_PROFILE_REASON };
    }
    try {
      const schema = await this.#get<GameSchemaResponse>("ISteamUserStats/GetSchemaForGame/v2/", {
        appid,
        l,
      });
      const has = (schema.game?.availableGameStats?.achievements?.length ?? 0) > 0;
      return {
        found: false,
        reason: has
          ? "This game has achievements, but the player's data is hidden (private game-details, or they don't own it)."
          : "This game has no achievements.",
      };
    } catch {
      return { found: false, reason: apiError || "Achievements unavailable." };
    }
  }

  async resolveVanityUrl(vanity: string): Promise<Record<string, unknown>> {
    const res = await this.#get<VanityResponse>("ISteamUser/ResolveVanityURL/v1/", {
      vanityurl: vanity,
    });
    return summarizeVanity(res);
  }

  // Batch GetPlayerSummaries for an arbitrary id list, chunked to its
  // 100-steamid-per-call limit. Shared by getFriendList and findFriendsWhoOwn,
  // both of which enrich a bare steamid list with names/state/avatar.
  async #playerSummaries(ids: string[]): Promise<PlayerSummariesResponse> {
    if (ids.length === 0) return {};
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    const responses = await Promise.all(
      chunks.map((chunk) =>
        this.#get<PlayerSummariesResponse>("ISteamUser/GetPlayerSummaries/v2/", {
          steamids: chunk.join(","),
        }),
      ),
    );
    return { response: { players: responses.flatMap((r) => r.response?.players ?? []) } };
  }

  // Fetch the raw friend list, translating a private friends list into `null`
  // instead of throwing. Shared by getFriendList and findFriendsWhoOwn.
  async #friendsRaw(steamid: string): Promise<FriendListResponse | null> {
    try {
      return await this.#get<FriendListResponse>("ISteamUser/GetFriendList/v1/", {
        steamid,
        relationship: "friend",
      });
    } catch (e) {
      if (e instanceof ApiError && (e.code === "forbidden" || e.code === "unauthorized"))
        return null;
      throw e;
    }
  }

  // A player's friend list (needs the friends list to be public). GetFriendList
  // only returns steamid + friend_since, so this enriches with names/state/avatar
  // via GetPlayerSummaries.
  async getFriendList(steamid: string): Promise<Record<string, unknown>> {
    const res = await this.#friendsRaw(steamid);
    if (res === null) return { found: false, reason: PRIVATE_FRIENDS_REASON };
    return summarizeFriendList(res, await this.#playerSummaries(friendIdsOf(res)));
  }

  // Which of a player's friends own a given set of appids, with playtime —
  // checked against each friend's FULL owned-games list (unlike get_owned_games,
  // never capped to the top 50 by playtime), so a rarely-played copy is never
  // missed. GetOwnedGames (unlike GetFriendList) doesn't error on a private
  // profile — it answers 200 with neither `games` nor `game_count`, which
  // #ownedPlaytimes reports as null.
  async findFriendsWhoOwn(steamid: string, appids: number[]): Promise<Record<string, unknown>> {
    const res = await this.#friendsRaw(steamid);
    if (res === null) return { found: false, reason: PRIVATE_FRIENDS_REASON };
    const ids = friendIdsOf(res);
    if (ids.length === 0) return summarizeFriendsWhoOwn(appids, [], [], {});
    const [players, ownership] = await Promise.all([
      this.#playerSummaries(ids),
      Promise.all(ids.map((id) => this.#ownedPlaytimes(id, appids))),
    ]);
    return summarizeFriendsWhoOwn(appids, ids, ownership, players);
  }

  // Playtime (minutes, playtime_forever) for just the requested appids a
  // steamid owns, or null when the profile/game-details are private. Only
  // requested appids are kept — the caller never needs the rest of the library.
  async #ownedPlaytimes(steamid: string, appids: number[]): Promise<Map<number, number> | null> {
    const res = await this.#get<OwnedGamesResponse>("IPlayerService/GetOwnedGames/v1/", {
      steamid,
      include_appinfo: false,
    });
    if (res.response?.games === undefined && res.response?.game_count === undefined) return null;
    const wanted = new Set(appids);
    const playtimes = new Map<number, number>();
    for (const g of res.response?.games ?? []) {
      if (typeof g.appid === "number" && wanted.has(g.appid))
        playtimes.set(g.appid, g.playtime_forever ?? 0);
    }
    return playtimes;
  }

  // ---- keyless-capable (key sent when present) ------------------------------

  async getNews(appid: number, count: number): Promise<Record<string, unknown>> {
    const res = await this.#get<NewsResponse>("ISteamNews/GetNewsForApp/v2/", {
      appid,
      count,
      maxlength: 400,
    });
    return summarizeNews(res);
  }

  async getGlobalAchievements(appid: number): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(`global-ach:${appid}`, async () => {
      const res = await this.#get<GlobalAchievementsResponse>(
        "ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/",
        { gameid: appid },
      );
      return summarizeGlobalAchievements(res);
    });
  }

  // Current concurrent player count for a game. Not cached — it's a live number.
  async getCurrentPlayers(appid: number): Promise<Record<string, unknown>> {
    const res = await this.#get<CurrentPlayersResponse>(
      "ISteamUserStats/GetNumberOfCurrentPlayers/v1/",
      { appid },
    );
    return summarizeCurrentPlayers(res, appid);
  }

  // The modern store-browse/query card services (get_items, discover_games) live
  // on StoreServiceClient (clients/storeService.ts); tools/webStore.ts calls it
  // directly via this getter rather than through pass-through methods here.
  // Shares this.#get/#cache (one rate limiter, one cache), so it's built once in
  // the constructor and exposed, not reconstructed by the caller.
  get store(): StoreServiceClient {
    return this.#store;
  }

  // A player's wishlist (needs the wishlist/profile to be public). Keyless.
  async #getWishlistLight(steamid: string): Promise<Record<string, unknown>> {
    const res = await this.#get<WishlistResponse>("IWishlistService/GetWishlist/v1/", { steamid });
    return summarizeWishlist(res);
  }

  // A player's followed games (needs the profile to be public). Keyless — a
  // separate opt-in "follow" feature from the wishlist; the count endpoint
  // reports the true total independent of any cap on the appid list.
  async getFollowedGames(steamid: string): Promise<Record<string, unknown>> {
    const [list, count] = await Promise.all([
      this.#get<FollowedGamesResponse>("IStoreService/GetGamesFollowed/v1/", { steamid }),
      this.#followedGamesCount(steamid),
    ]);
    return summarizeFollowedGames(list, count);
  }

  // The count is a best-effort cross-check (summarizeFollowedGames falls back to
  // appids.length) — never let it turn a working getFollowedGames call into an error.
  async #followedGamesCount(steamid: string): Promise<FollowedGamesCountResponse> {
    try {
      return await this.#get<FollowedGamesCountResponse>(
        "IStoreService/GetGamesFollowedCount/v1/",
        {
          steamid,
        },
      );
    } catch {
      return {};
    }
  }

  #getWishlistDetailed(
    steamid: string,
    opts?: Parameters<StoreServiceClient["getWishlistDetailed"]>[1],
  ): Promise<Record<string, unknown>> {
    return this.#store.getWishlistDetailed(steamid, opts);
  }

  // Single entry point for the get_wishlist tool: decides light vs detailed the
  // same way the tool schema implies it — any filter field being SET switches to
  // the enriched card view, since the light appid list carries no price to
  // filter on. onSaleOnly is checked by value (only `true` implies detailed)
  // since `false` is a meaningful "don't require a discount", not an opt-in to
  // detailed mode.
  async getWishlist(
    steamid: string,
    opts: NonNullable<Parameters<StoreServiceClient["getWishlistDetailed"]>[1]> & {
      includeDetails?: boolean;
    } = {},
  ): Promise<Record<string, unknown>> {
    const { includeDetails, onSaleOnly, ...filters } = opts;
    const detailed =
      includeDetails || onSaleOnly || Object.values(filters).some((v) => v !== undefined);
    return detailed
      ? this.#getWishlistDetailed(steamid, { onSaleOnly, ...filters })
      : this.#getWishlistLight(steamid);
  }

  // Full achievement list for a game (GetSchemaForGame needs a key), merged with
  // the keyless global unlock % so each achievement carries its rarity. Cached.
  async getGameAchievements(appid: number, language?: string): Promise<Record<string, unknown>> {
    const l = language ?? this.#l;
    return this.#cache.wrapStaleOnError(`schema:${appid}:${l}`, async () => {
      const [schema, global] = await Promise.all([
        this.#get<GameSchemaResponse>("ISteamUserStats/GetSchemaForGame/v2/", {
          appid,
          l,
        }),
        this.#get<GlobalAchievementsResponse>(
          "ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/",
          { gameid: appid },
        ),
      ]);
      return summarizeGameSchema(schema, global);
    });
  }
}
