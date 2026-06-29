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
  summarizeCurrentPlayers,
  summarizeGameSchema,
  summarizeGlobalAchievements,
  summarizeNews,
  summarizeOwnedGames,
  summarizePlayer,
  summarizePlayerAchievements,
  summarizeRecentlyPlayed,
  summarizeVanity,
  summarizeWishlist,
  type CurrentPlayersResponse,
  type GameSchemaResponse,
  type GlobalAchievementsResponse,
  type NewsResponse,
  type OwnedGamesResponse,
  type PlayerAchievementsResponse,
  type PlayerSummariesResponse,
  type VanityResponse,
  type WishlistResponse,
} from "../format.js";
import type { Logger } from "../lib/logger.js";
import type { Config } from "../config.js";

type Query = Record<string, string | number | boolean | undefined>;

const PRIVATE_PROFILE_REASON =
  "Profile or game-details are private. Ask the owner to set Steam → Privacy → " +
  "Game details = Public.";

export class SteamWebClient {
  readonly #http: HttpClient;
  readonly #cache: TtlCache<Record<string, unknown>>;
  readonly #key: string | undefined;
  readonly #l: string;
  /** True when a Steam Web API key is configured; player tools short-circuit otherwise. */
  readonly configured: boolean;

  constructor(config: Config, logger: Logger) {
    this.#key = config.steamApiKey;
    this.#l = config.language;
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
  }

  #get<T>(path: string, query: Query): Promise<T> {
    return this.#http.getJson<T>(path, { query: { key: this.#key, ...query } });
  }

  // ---- player data (key required) -------------------------------------------

  async getPlayerSummary(steamid: string): Promise<Record<string, unknown>> {
    const res = await this.#get<PlayerSummariesResponse>("ISteamUser/GetPlayerSummaries/v2/", {
      steamids: steamid,
    });
    return summarizePlayer(res);
  }

  async getOwnedGames(steamid: string): Promise<Record<string, unknown>> {
    const res = await this.#get<OwnedGamesResponse>("IPlayerService/GetOwnedGames/v1/", {
      steamid,
      include_appinfo: true,
      include_played_free_games: true,
    });
    return summarizeOwnedGames(res);
  }

  async getRecentlyPlayed(steamid: string): Promise<Record<string, unknown>> {
    const res = await this.#get<OwnedGamesResponse>("IPlayerService/GetRecentlyPlayedGames/v1/", {
      steamid,
    });
    return summarizeRecentlyPlayed(res);
  }

  async getPlayerAchievements(steamid: string, appid: number): Promise<Record<string, unknown>> {
    try {
      const res = await this.#get<PlayerAchievementsResponse>(
        "ISteamUserStats/GetPlayerAchievements/v1/",
        { steamid, appid, l: this.#l },
      );
      if (res.playerstats?.success) return summarizePlayerAchievements(res);
      // 200 but success:false — disambiguate private vs no-achievements.
      return this.#explainNoPlayerAchievements(appid, res.playerstats?.error);
    } catch (e) {
      // Steam answers 403 for a private profile, 400 for an app with no stats /
      // not owned. Turn both into a clear, actionable reason.
      if (e instanceof ApiError && (e.code === "forbidden" || e.code === "unauthorized")) {
        return { found: false, reason: PRIVATE_PROFILE_REASON };
      }
      if (e instanceof ApiError && (e.code === "bad_request" || e.code === "not_found")) {
        return this.#explainNoPlayerAchievements(appid);
      }
      throw e;
    }
  }

  // On failure, check the game's schema: if it HAS achievements the player data
  // is hidden (private/not owned); if it has none, the game simply has no
  // achievements. Only runs on the failure path, so the happy path stays 1 call.
  async #explainNoPlayerAchievements(
    appid: number,
    apiError?: string,
  ): Promise<Record<string, unknown>> {
    if (apiError && /not public|private/i.test(apiError)) {
      return { found: false, reason: PRIVATE_PROFILE_REASON };
    }
    try {
      const schema = await this.#get<GameSchemaResponse>("ISteamUserStats/GetSchemaForGame/v2/", {
        appid,
        l: this.#l,
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

  // A player's wishlist (needs the wishlist/profile to be public). Keyless.
  async getWishlist(steamid: string): Promise<Record<string, unknown>> {
    const res = await this.#get<WishlistResponse>("IWishlistService/GetWishlist/v1/", { steamid });
    return summarizeWishlist(res);
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
