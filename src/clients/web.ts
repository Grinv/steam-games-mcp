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
  summarizeDiscover,
  summarizeItems,
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
  type StoreItemsResponse,
  type StoreQueryResponse,
  type VanityResponse,
  type WishlistResponse,
} from "../format/web.js";
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
  readonly #country: string;
  readonly #defaultSteamId: string | undefined;
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

  // Batch store card (price+discount, review %, release) for a list of appids in
  // one keyless call via the modern store-browse service. The efficient way to
  // price- and rating-check a known list (wishlist/library) without N requests.
  async getItems(
    appids: number[],
    country?: string,
    language?: string,
  ): Promise<Record<string, unknown>> {
    const input = {
      ids: appids.map((appid) => ({ appid })),
      context: { language: language ?? this.#l, country_code: country ?? this.#country },
      data_request: {
        include_basic_info: true,
        include_reviews: true,
        include_release: true,
        include_platforms: true, // brings steam_deck_compat_category
      },
    };
    const res = await this.#get<StoreItemsResponse>("IStoreBrowseService/GetItems/v1/", {
      input_json: JSON.stringify(input),
    });
    return summarizeItems(res, appids);
  }

  // Shared catalog discovery over the keyless store query backend (discoverGames
  // is a thin preset over this). The Query API can't filter/sort on reviews,
  // Deck or release date, so those are applied in
  // summarizeDiscover over the returned page — which is why we sort by
  // popularity (sort:10): without a sort the page is appid-ordered and fills
  // with obscure, Deck-untested shovelware, making the post-filters return
  // nothing useful. Popularity puts real games (with Deck ratings + review
  // counts) into the window.
  async #queryCatalog(p: {
    minDiscount?: number;
    releasedOnly?: boolean;
    count?: number;
    start?: number;
    minReview?: number;
    minReviews?: number;
    steamDeck?: string;
    releasedAfter?: number;
    country?: string;
    language?: string;
  }): Promise<Record<string, unknown>> {
    const filters: Record<string, unknown> = {};
    if (typeof p.minDiscount === "number")
      filters.price_filters = { min_discount_percent: p.minDiscount };
    if (p.releasedOnly) filters.released_only = true;
    const input = {
      query: { start: p.start ?? 0, count: p.count ?? 50, sort: 10, filters },
      context: {
        language: p.language ?? this.#l,
        country_code: p.country ?? this.#country,
        steam_realm: 1,
      },
      // include_platforms → steam_deck_compat_category; include_release → date.
      data_request: {
        include_basic_info: true,
        include_reviews: true,
        include_platforms: true,
        include_release: true,
      },
    };
    const res = await this.#get<StoreQueryResponse>("IStoreQueryService/Query/v1/", {
      input_json: JSON.stringify(input),
    });
    return summarizeDiscover(res, {
      minReview: p.minReview,
      minReviews: p.minReviews,
      steamDeck: p.steamDeck,
      releasedAfter: p.releasedAfter,
    });
  }

  // Catalog-wide game discovery: browse by discount, recency, Steam Deck support
  // and review quality, in any combination. Every filter is optional — pass
  // minDiscount for "on sale", releasedAfter for "new", steamDeck for "runs on
  // Deck", or mix them. released_only is set only when a recency cutoff is given,
  // so a pure deal query still surfaces pre-purchase discounts.
  async discoverGames(p: {
    releasedAfter?: number;
    minDiscount?: number;
    count?: number;
    start?: number;
    minReview?: number;
    minReviews?: number;
    steamDeck?: string;
    country?: string;
    language?: string;
  }): Promise<Record<string, unknown>> {
    return this.#queryCatalog({ ...p, releasedOnly: p.releasedAfter !== undefined });
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
