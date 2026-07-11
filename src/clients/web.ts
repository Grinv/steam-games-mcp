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
  summarizeFriendList,
  summarizeFriendsWhoOwn,
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
  type FriendListResponse,
  type GameSchemaResponse,
  type GlobalAchievementsResponse,
  type NewsResponse,
  type OwnedGamesResponse,
  type PlayerAchievementsResponse,
  type PlayerSummariesResponse,
  type VanityResponse,
  type WishlistResponse,
} from "../format/web.js";
import {
  summarizeDiscover,
  summarizeItems,
  summarizeTagList,
  summarizeWishlistDetailed,
  type GetTagListResponse,
  type StoreItemsResponse,
  type StoreQueryResponse,
  type TagMap,
  type WishlistDetailedResponse,
} from "../format/store.js";
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

// The include_* flags every store-service card call needs (basic info, reviews,
// release, native platforms + compat, popular tags). tagCount varies: fewer for
// display-only (get_items), more when tags are also filtered (discover/wishlist).
const storeCardDataRequest = (tagCount: number) => ({
  include_basic_info: true,
  include_reviews: true,
  include_release: true,
  include_platforms: true,
  include_tag_count: tagCount,
});

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

  // Tag dictionary (tagid → localized name) from IStoreService/GetTagList
  // (keyless). Store items carry only numeric tagids; this resolves them to the
  // readable tag names surfaced on each card. Cached per language and tiny
  // (~450 entries, stable), so one fetch serves many cards.
  // Returns null (rather than throwing) on upstream failure — callers that only
  // DISPLAY tags can degrade gracefully (empty tags list); callers that FILTER
  // by tags must check for null themselves and fail loudly instead of silently
  // returning zero matches (an empty dictionary would make every tag filter
  // reject every item, indistinguishable from "no games matched").
  async #tagNames(language: string): Promise<TagMap | null> {
    try {
      const map = await this.#cache.wrapStaleOnError(`tags:${language}`, async () => {
        const res = await this.#get<GetTagListResponse>("IStoreService/GetTagList/v1/", {
          language,
        });
        return summarizeTagList(res) as Record<string, unknown>;
      });
      return map as TagMap;
    } catch {
      return null;
    }
  }

  // Throws when a tags filter was requested but the tag dictionary is
  // unavailable — never silently treats that as "nothing matched".
  #requireTagMapIfFiltering(tags: string[] | undefined, tagMap: TagMap | null): TagMap | undefined {
    if (tagMap !== null) return tagMap;
    if (!tags?.length) return undefined;
    // "unknown" is the one ApiErrorCode whose mapped message (lib/result.ts)
    // includes our own text verbatim — the other codes render a fixed,
    // generic sentence per code and would swallow this explanation.
    throw new ApiError({
      code: "unknown",
      message:
        "could not fetch Steam's tag dictionary right now, so the `tags` filter can't be " +
        "reliably applied. Retry, or drop `tags` to see unfiltered results.",
      retryable: true,
    });
  }

  // Batch store card (price+discount, review %, compat, popular tags, release) for
  // a list of appids in one keyless call via the modern store-browse service. The
  // efficient way to price-, rating- and tag-check a known list (wishlist/library)
  // without N requests. Tag names come from a second, cached dictionary lookup.
  async getItems(
    appids: number[],
    country?: string,
    language?: string,
  ): Promise<Record<string, unknown>> {
    const l = language ?? this.#l;
    const input = {
      ids: appids.map((appid) => ({ appid })),
      context: { language: l, country_code: country ?? this.#country },
      data_request: storeCardDataRequest(15), // 15 tags: display-only (get_items doesn't tag-filter)
    };
    const [res, tagMap] = await Promise.all([
      this.#get<StoreItemsResponse>("IStoreBrowseService/GetItems/v1/", {
        input_json: JSON.stringify(input),
      }),
      this.#tagNames(l),
    ]);
    // get_items never filters by tags — a failed dictionary just means the
    // `tags` display field comes back empty, which resolveTags already handles.
    return summarizeItems(res, appids, tagMap ?? undefined);
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
    steamOs?: string;
    steamFrame?: string;
    platform?: "windows" | "mac" | "linux";
    releasedAfter?: number;
    tags?: string[];
    country?: string;
    language?: string;
  }): Promise<Record<string, unknown>> {
    const l = p.language ?? this.#l;
    const filters: Record<string, unknown> = {};
    if (typeof p.minDiscount === "number")
      filters.price_filters = { min_discount_percent: p.minDiscount };
    if (p.releasedOnly) filters.released_only = true;
    const input = {
      query: { start: p.start ?? 0, count: p.count ?? 50, sort: 10, filters },
      context: {
        language: l,
        country_code: p.country ?? this.#country,
        steam_realm: 1,
      },
      data_request: storeCardDataRequest(20), // 20 tags: full set so tag filtering isn't capped
    };
    // Fetch the tag dictionary alongside the page (cached, so ~free after the
    // first call) — every card surfaces resolved tag names.
    const [res, tagMap] = await Promise.all([
      this.#get<StoreQueryResponse>("IStoreQueryService/Query/v1/", {
        input_json: JSON.stringify(input),
      }),
      this.#tagNames(l),
    ]);
    return summarizeDiscover(res, {
      minReview: p.minReview,
      minReviews: p.minReviews,
      steamDeck: p.steamDeck,
      steamOs: p.steamOs,
      steamFrame: p.steamFrame,
      platform: p.platform,
      releasedAfter: p.releasedAfter,
      tags: p.tags,
      tagMap: this.#requireTagMapIfFiltering(p.tags, tagMap),
    });
  }

  // Catalog-wide game discovery: browse by discount, recency, hardware
  // compatibility (Steam Deck / SteamOS / Steam Frame) and review quality, in any
  // combination. Every filter is optional — pass minDiscount for "on sale",
  // releasedAfter for "new", steamDeck/steamOs/steamFrame for "runs on X", or mix
  // them. released_only is set only when a recency cutoff is given, so a pure deal
  // query still surfaces pre-purchase discounts.
  async discoverGames(p: {
    releasedAfter?: number;
    minDiscount?: number;
    count?: number;
    start?: number;
    minReview?: number;
    minReviews?: number;
    steamDeck?: string;
    steamOs?: string;
    steamFrame?: string;
    platform?: "windows" | "mac" | "linux";
    tags?: string[];
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

  // Enriched wishlist: GetWishlistSortedFiltered embeds a full store card per
  // entry, so "my wishlist with prices / deals" is one keyless call instead of
  // getWishlist + getItems. Also fetches the (cached) tag dictionary to resolve
  // tag names. onSaleOnly keeps just the discounted entries, ranked by discount.
  async getWishlistDetailed(
    steamid: string,
    opts: {
      onSaleOnly?: boolean;
      tags?: string[];
      minReview?: number;
      minDiscount?: number;
      platform?: "windows" | "mac" | "linux";
      steamDeck?: string;
      steamOs?: string;
      steamFrame?: string;
      country?: string;
      language?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const l = opts.language ?? this.#l;
    const input = {
      steamid,
      context: { language: l, country_code: opts.country ?? this.#country, steam_realm: 1 },
      data_request: storeCardDataRequest(20), // 20 tags: full set so tag filtering isn't capped
      sort: 0,
    };
    const [res, tagMap] = await Promise.all([
      this.#get<WishlistDetailedResponse>("IWishlistService/GetWishlistSortedFiltered/v1/", {
        input_json: JSON.stringify(input),
      }),
      this.#tagNames(l),
    ]);
    const safeTagMap = this.#requireTagMapIfFiltering(opts.tags, tagMap);
    return summarizeWishlistDetailed(res, safeTagMap, {
      onSaleOnly: opts.onSaleOnly,
      tags: opts.tags,
      minReview: opts.minReview,
      minDiscount: opts.minDiscount,
      platform: opts.platform,
      steamDeck: opts.steamDeck,
      steamOs: opts.steamOs,
      steamFrame: opts.steamFrame,
    });
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
