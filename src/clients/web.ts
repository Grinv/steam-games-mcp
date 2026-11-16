// Read-only client for the official Steam Web API (api.steampowered.com).
// Valve states that all Web API use requires a free key
// (https://steamcommunity.com/dev/apikey), so player tools require STEAM_API_KEY.
// Several endpoints (news, global achievement %, current players, wishlist,
// followed games — see docs/architecture.md's "Keyless caveat") currently
// also answer without a key; we send the key when present and let them work
// either way.
// Reference: https://developer.valvesoftware.com/wiki/Steam_Web_API
import { HttpClient } from "../lib/http.ts";
import { RateLimiter } from "../lib/rateLimit.ts";
import { ApiError } from "../lib/errors.ts";
import {
  call,
  type Answered,
  type CallOptions,
  type Endpoint,
  type Query,
} from "../lib/endpoint.ts";
import { Steam, classifySteamApiError } from "./endpoints.ts";
import { noteDegraded, optional, optionalParts } from "../lib/call.ts";
import { settledWithLimit } from "../lib/concurrency.ts";
import { notFound, PRIVATE_PROFILE_REASON, STEAMID64_RE } from "../format/shared.ts";
import {
  FRIENDS_CHECKED_MAX,
  friendIdsToEnrich,
  isPrivateOwnedGames,
  summarizeComparePlayers,
  summarizeCurrentPlayers,
  summarizeFollowedGames,
  summarizeFriendList,
  summarizeFriendsWhoOwn,
  summarizeNews,
  summarizeReviews,
  summarizeOwnedGames,
  summarizePlayer,
  summarizePlayerBans,
  summarizeRecentlyPlayed,
  RECENTLY_PLAYED_MAX,
  summarizeVanity,
  summarizeWishlist,
  RESULT_OK,
  type CurrentPlayersResponse,
  type OwnedGamesSort,
  type FollowedGamesCountResponse,
  type FollowedGamesResponse,
  type FriendListResponse,
  type OwnedGamesResponse,
  type PlayerSummariesResponse,
} from "../format/web.ts";
import {
  summarizeGameSchema,
  summarizeGlobalAchievements,
  summarizePlayerAchievements,
  type GameSchemaResponse,
} from "../format/webAchievements.ts";
import { StoreServiceClient } from "./storeService.ts";
import type { Logger } from "../lib/logger.ts";
import type { Config } from "../config.ts";

// The community site, used for exactly one thing: resolving a vanity STEAM_ID
// without a key (see #vanityViaCommunity). Not a config knob — it isn't an API
// this server otherwise talks to, and there's nothing to point elsewhere.
const STEAM_COMMUNITY_BASE_URL = "https://steamcommunity.com";

// GetFriendList answers the same way for a private list and for a SteamID64
// with no account behind it at all (#FRIENDLIST_NOT_FOUND_CODES below folds
// not_found in deliberately). Naming only the privacy case told the caller to
// go change a setting on an account that doesn't exist — confirmed live on
// 76561197960265728, which get_player_summary correctly reports as no such
// account. Both causes, like every sibling that can fail two ways.
const PRIVATE_FRIENDS_REASON =
  "Friends list is private, or there is no Steam account with that SteamID64. Check the id " +
  "(resolve a vanity name with resolve_vanity_url), or ask the owner to set Steam → Privacy → " +
  "Friends List = Public.";

const hasAchievements = (schema: GameSchemaResponse) =>
  (schema.game?.availableGameStats?.achievements?.length ?? 0) > 0;

// GetGlobalAchievementPercentagesForApp's 403 ("no data") for a game whose
// schema lists achievements: the edge's passing block, not an answer.
function rarityBlocked(appid: number): ApiError {
  return new ApiError({
    code: "forbidden",
    status: 403,
    hadCredentials: false,
    retryable: true,
    message: `GetGlobalAchievementPercentagesForApp 403 for appid ${appid}, whose schema lists achievements`,
    detail:
      "Steam refused the rarity data of a game that has achievements — most likely a passing block.",
  });
}

function friendIdsOf(r: FriendListResponse): string[] {
  return (r.friendslist?.friends ?? [])
    .map((f) => f.steamid)
    .filter((id): id is string => Boolean(id));
}

export class SteamWebClient {
  readonly #http: HttpClient;
  readonly #key: string | undefined;
  readonly #l: string;
  readonly #country: string;
  readonly #defaultSteamId: string | undefined;
  // The modern store-browse/query/wishlist-sorted services (get_items,
  // discover_games, get_wishlist's include_details) — see clients/storeService.ts.
  readonly #store: StoreServiceClient;
  // Memoised result of resolving a vanity STEAM_ID default to a SteamID64.
  #resolvedDefault: string | undefined;
  // steamcommunity.com, for the keyless vanity fallback below only — a third
  // host, so it can't share #http (api.steampowered.com) or its rate limiter.
  readonly #community: HttpClient;
  readonly #logger: Logger;
  /** True when a Steam Web API key is configured; player tools short-circuit otherwise. */
  readonly configured: boolean;

  constructor(config: Config, logger: Logger) {
    this.#logger = logger;
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
      beforeRequest: (signal) => limiter.acquire(signal),
      hasCredentials: this.configured,
      cacheTtlMs: config.cacheTtlMs,
      classify: classifySteamApiError,
    });
    this.#community = new HttpClient({
      baseUrl: STEAM_COMMUNITY_BASE_URL,
      logger,
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      hasCredentials: false,
    });
    // Shares this #http (one rate limiter, one cache) rather than owning its
    // own — both clients hit the same api.steampowered.com host.
    this.#store = new StoreServiceClient({
      call: this.#call.bind(this),
      language: this.#l,
      country: this.#country,
    });
  }

  // Every api.steampowered.com call: the key is sent whenever configured (a
  // keyless endpoint just ignores it), and the endpoint's own facts —
  // clients/endpoints.ts — decide what Steam's answer means.
  #call<T, A extends string>(
    ep: Endpoint<T, A>,
    query: Query,
    opts?: CallOptions,
  ): Promise<Answered<T, A>> {
    return call(this.#http, ep, query, opts, { key: this.#key });
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
        message: "no steamid argument and no STEAM_ID default",
        detail:
          "No steamid was given and STEAM_ID is not set. Pass a 17-digit SteamID64, or set " +
          "STEAM_ID (a SteamID64 or vanity name) in the server config.",
      });
    }
    if (STEAMID64_RE.test(raw)) return raw;
    if (this.#resolvedDefault) return this.#resolvedDefault;
    // The official lookup when a key is set, the keyless community profile
    // otherwise — and as a backstop when the keyed attempt fails, since a
    // mistyped key 403ing here would otherwise take get_wishlist and
    // get_followed_games down with it, and neither needs a key of its own.
    // The community profile is always the last word: if it answers "no such
    // profile", that's definitive even when the keyed attempt hit a 429. Only
    // when that final attempt itself failed transiently (429/5xx/timeout, which
    // says nothing about the name) is the error rethrown rather than reported
    // as "check the spelling" of a STEAM_ID that may well be fine.
    let transient: ApiError | undefined;
    const attempt = (p: Promise<string | undefined>) =>
      p.catch((e: unknown) => {
        // Only an upstream failure means "try the next lookup"; a bug isn't one.
        if (!(e instanceof ApiError)) throw e;
        this.#logger.debug("STEAM_ID vanity lookup failed:", e);
        if (e.retryable) transient = e;
        return undefined;
      });
    let steamid = this.configured ? await attempt(this.#vanityViaApi(raw)) : undefined;
    if (!steamid) {
      transient = undefined;
      steamid = await attempt(this.#vanityViaCommunity(raw));
    }
    if (!steamid && transient) throw transient;
    if (!steamid) {
      throw new ApiError({
        code: "not_found",
        message: `STEAM_ID vanity name "${raw}" did not resolve`,
        detail:
          `Could not resolve the STEAM_ID vanity name "${raw}" to a SteamID64 — check the ` +
          "spelling (it's the part after /id/ in the profile URL, and the profile must exist), " +
          "or set STEAM_ID to a 17-digit SteamID64 instead.",
      });
    }
    this.#resolvedDefault = steamid;
    return steamid;
  }

  async #vanityViaApi(vanity: string): Promise<string | undefined> {
    const res = await this.#call(Steam.ResolveVanityURL, { vanityurl: vanity });
    return res.response?.success === RESULT_OK ? res.response.steamid : undefined;
  }

  /** Keyless vanity resolution: a public profile's `?xml=1` view carries the
   *  SteamID64, so a vanity STEAM_ID doesn't cost the keyless-capable tools
   *  (get_wishlist, get_followed_games) their independence from the key — with a
   *  numeric STEAM_ID they work without one, and they should either way.
   *  Matched with a regex rather than parsed: one known element in a
   *  fixed-shape document isn't worth an XML dependency. A missing profile
   *  answers HTTP 200 with an <error> body and no steamID64, which simply
   *  yields undefined. */
  async #vanityViaCommunity(vanity: string): Promise<string | undefined> {
    const xml = await this.#community.getText(`id/${encodeURIComponent(vanity)}/`, {
      query: { xml: 1 },
    });
    return /<steamID64>(\d{17})<\/steamID64>/.exec(xml)?.[1];
  }

  // ---- player data (key required) -------------------------------------------

  async getPlayerSummary(steamid: string): Promise<Record<string, unknown>> {
    const [res, level] = await Promise.all([
      this.#call(Steam.GetPlayerSummaries, { steamids: steamid }),
      this.#steamLevel(steamid),
    ]);
    return summarizePlayer(res, level);
  }

  // GetSteamLevel has its own failure mode (independent of the summary lookup);
  // never let it turn a working get_player_summary call into an error. Cached
  // like the other small, semi-static enrichment fetches (#tagNames,
  // getGlobalAchievements), so a transient failure falls back to the
  // last-known level instead of degrading to null every time.
  async #steamLevel(steamid: string): Promise<number | null> {
    const res = await optional(
      "Steam level",
      this.#call(Steam.GetSteamLevel, { steamid }, { cache: true }),
    );
    return res?.data?.response?.player_level ?? null;
  }

  async getPlayerBans(steamid: string): Promise<Record<string, unknown>> {
    return summarizePlayerBans(await this.#call(Steam.GetPlayerBans, { steamids: steamid }));
  }

  // GetOwnedGames, with Steam's "no such steamid" answer (accountid 0) read
  // like its usual empty private/not-found shape. Shared by getOwnedGames,
  // getRecommendedGames, comparePlayers and #ownedPlaytimes.
  async #ownedGamesRaw(steamid: string, query: Query): Promise<OwnedGamesResponse> {
    const res = await this.#call(Steam.GetOwnedGames, { steamid, ...query });
    return res.answer ? {} : res.data;
  }

  async getOwnedGames(
    steamid: string,
    checkAppids?: number[],
    opts: { max?: number; sort?: OwnedGamesSort } = {},
  ): Promise<Record<string, unknown>> {
    const res = await this.#ownedGamesRaw(steamid, {
      include_appinfo: true,
      include_played_free_games: true,
    });
    // Deduped: each `owns` row answers one appid, so a repeated one only
    // repeated the row.
    const unique = checkAppids && [...new Set(checkAppids)];
    return summarizeOwnedGames(res, { checkAppids: unique, ...opts });
  }

  async getRecentlyPlayed(steamid: string): Promise<Record<string, unknown>> {
    const res = await this.#call(Steam.GetRecentlyPlayedGames, {
      steamid,
      count: RECENTLY_PLAYED_MAX,
    });
    return summarizeRecentlyPlayed(res.answer ? {} : res.data);
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
    const res = await this.#ownedGamesRaw(steamid, {
      include_appinfo: false,
      // Without this, Steam omits free-to-play games from the owned list
      // entirely — they'd then not only miss tag-weighting but, worse, never
      // get excluded as "already owned" and could be recommended back.
      include_played_free_games: true,
    });
    if (isPrivateOwnedGames(res)) {
      return notFound(PRIVATE_PROFILE_REASON);
    }
    const games = (res.response?.games ?? [])
      .filter((g): g is { appid: number; playtime_forever?: number } => typeof g.appid === "number")
      .map((g) => ({ appid: g.appid, playtimeMinutes: g.playtime_forever ?? 0 }));
    return this.#store.getRecommendedGames(games, opts);
  }

  // Shared games between two players' FULL libraries, unlike get_owned_games
  // which caps to the top 50 by playtime — comparing needs the whole list.
  async comparePlayers(steamidA: string, steamidB: string): Promise<Record<string, unknown>> {
    // Promise.all: the shared list needs both libraries, so there is no partial
    // result. A failure (429/5xx, a bad key) surfaces as the same tool error the
    // sibling tools return; a found:false here would read as a final answer.
    const [a, b] = await Promise.all([
      this.#ownedGamesRaw(steamidA, { include_appinfo: true, include_played_free_games: true }),
      this.#ownedGamesRaw(steamidB, { include_appinfo: true, include_played_free_games: true }),
    ]);
    return summarizeComparePlayers(a, b);
  }

  async getPlayerAchievements(
    steamid: string,
    appid: number,
    language?: string,
  ): Promise<Record<string, unknown>> {
    const l = language ?? this.#l;
    const res = await this.#call(Steam.GetPlayerAchievements, { steamid, appid, l });
    if (res.answer) {
      return res.answer === "private"
        ? notFound(PRIVATE_PROFILE_REASON)
        : this.#explainNoPlayerAchievements(appid, l);
    }
    if (res.data.playerstats?.success) return summarizePlayerAchievements(res.data);
    // 200 but success:false — disambiguate private vs no-achievements.
    return this.#explainNoPlayerAchievements(appid, l, res.data.playerstats?.error);
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
      return notFound(PRIVATE_PROFILE_REASON);
    }
    // The same cached request get_game_achievements makes. Only Steam's
    // answer reads as a verdict; a failure (or a bug, a cancel) propagates.
    const schema = await this.#call(Steam.GetSchemaForGame, { appid, l }, { cache: true });
    if (schema.answer) {
      // Steam's own error text only classifies (above), never reaches the agent.
      return notFound(
        "No achievement data for this appid: the game has no achievements or stats, or the " +
          "appid doesn't exist.",
      );
    }
    return notFound(
      hasAchievements(schema.data)
        ? "This game has achievements, but the player's data is hidden (private game-details, or they don't own it)."
        : "This game has no achievements.",
    );
  }

  async resolveVanityUrl(vanity: string): Promise<Record<string, unknown>> {
    return summarizeVanity(await this.#call(Steam.ResolveVanityURL, { vanityurl: vanity }));
  }

  // Batch GetPlayerSummaries for an arbitrary id list, chunked to its
  // 100-steamid-per-call limit. Shared by getFriendList and findFriendsWhoOwn,
  // both of which enrich a bare steamid list with names/state/avatar.
  //
  // Promise.allSettled, not Promise.all: a friend list of any real size can
  // span 2+ chunks, and one chunk's transient failure (rate-limited/network/
  // 5xx) must not blank out every other chunk's names — a caller's nameOf()
  // helper already degrades a missing entry to `name: null`, the same
  // fallback it uses for a steamid Steam simply has no data for.
  async #playerSummaries(ids: string[]): Promise<PlayerSummariesResponse> {
    if (ids.length === 0) return {};
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    const settled = await Promise.allSettled(
      chunks.map((chunk) => this.#call(Steam.GetPlayerSummaries, { steamids: chunk.join(",") })),
    );
    const players = optionalParts(settled, (i) => `Names of ${chunks[i]!.length} players`).flatMap(
      (r) => r.response?.players ?? [],
    );
    return { response: { players } };
  }

  // Fetch the raw friend list; `null` for Steam's "private or no such account"
  // answer. Shared by getFriendList and findFriendsWhoOwn.
  async #friendsRaw(steamid: string): Promise<FriendListResponse | null> {
    const res = await this.#call(Steam.GetFriendList, { steamid, relationship: "friend" });
    return res.answer ? null : res.data;
  }

  // A player's friend list (needs the friends list to be public). GetFriendList
  // only returns steamid + friend_since, so this enriches with names/state/avatar
  // via GetPlayerSummaries.
  async getFriendList(steamid: string): Promise<Record<string, unknown>> {
    const res = await this.#friendsRaw(steamid);
    if (res === null) return notFound(PRIVATE_FRIENDS_REASON);
    return summarizeFriendList(res, await this.#playerSummaries(friendIdsToEnrich(res)));
  }

  // Which of a player's friends own a given set of appids, with playtime —
  // checked against each friend's FULL owned-games list (unlike get_owned_games,
  // never capped to the top 50 by playtime), so a rarely-played copy is never
  // missed. GetOwnedGames (unlike GetFriendList) doesn't error on a private
  // profile — it answers 200 with neither `games` nor `game_count`, which
  // #ownedPlaytimes reports as null.
  // How many per-friend GetOwnedGames calls may be in flight at once. Low
  // enough that a 2000-friend account doesn't stampede api.steampowered.com,
  // high enough that a normal friend list still resolves in a few round-trips.
  static readonly #FRIEND_LOOKUP_CONCURRENCY = 10;

  async findFriendsWhoOwn(steamid: string, requested: number[]): Promise<Record<string, unknown>> {
    // Deduped before anything else: the shaper emits one match per listed
    // appid and adds each friend once per listing, so [620, 620] used to
    // report every owner twice in each of two identical matches.
    const appids = [...new Set(requested)];
    const res = await this.#friendsRaw(steamid);
    if (res === null) return notFound(PRIVATE_FRIENDS_REASON);
    const allIds = friendIdsOf(res);
    if (allIds.length === 0) return summarizeFriendsWhoOwn(appids, [], [], {});
    // Two bounds, both measured live on a 634-friend account:
    //
    // FRIENDS_CHECKED_MAX caps how many friends are looked up at all. One
    // GetOwnedGames call per friend is unavoidable, so a big account is a wall:
    // checking all 634 runs past the 60s default request timeout an MCP client
    // gives up at, failing the whole call. `friends_checked` reports how many
    // were read so a gap never reads as "doesn't own it".
    //
    // #FRIEND_LOOKUP_CONCURRENCY caps how many run at once. Unbounded (through
    // 0.12.2) the fan-out rate-limited itself: that same account reported 527 of
    // its 634 friends as `unavailable` with a 420, which the allSettled below
    // then dutifully passed off as a normal result.
    // friendIdsToEnrich, not a raw slice: it applies get_friend_list's own
    // most-recently-added-first ordering, so "the 200 checked" is a subset an
    // agent can actually name — a raw slice took Steam's arbitrary payload order,
    // which barely overlaps the 100 get_friend_list shows for the same account.
    const ids = friendIdsToEnrich(res, FRIENDS_CHECKED_MAX);
    // settledWithLimit, not Promise.all: #ownedPlaytimes only returns null for a
    // private profile (see below) — a genuine transient failure (rate-limited/
    // network/timeout/5xx) on ONE friend's own GetOwnedGames call still throws,
    // and with a friend list of any size that's not a rare case. One friend's
    // bad luck must not sink everyone else's results.
    const [players, settled] = await Promise.all([
      this.#playerSummaries(ids),
      settledWithLimit(ids, SteamWebClient.#FRIEND_LOOKUP_CONCURRENCY, (id) =>
        this.#ownedPlaytimes(id, appids),
      ),
    ]);
    // One note per distinct cause, so a mix (a timeout here, a 429 there)
    // isn't reported as whichever came first.
    const failedByCause = new Map<string, ApiError[]>();
    const ownership = settled.map((r) => {
      if (r.status === "fulfilled") return r.value;
      // One friend's upstream failure is theirs alone; a bug fails the call.
      if (!(r.reason instanceof ApiError)) throw r.reason;
      const cause = `${r.reason.code}:${r.reason.status ?? ""}`;
      failedByCause.set(cause, [...(failedByCause.get(cause) ?? []), r.reason]);
      return r.reason;
    });
    for (const errs of failedByCause.values()) {
      noteDegraded(`Game ownership of ${errs.length} friends (see unavailable_friends)`, errs[0]!);
    }
    return summarizeFriendsWhoOwn(appids, ids, ownership, players, {
      totalFriends: allIds.length,
    });
  }

  // Playtime (minutes, playtime_forever) for just the requested appids a
  // steamid owns, or null when the profile/game-details are private. Only
  // requested appids are kept — the caller never needs the rest of the library.
  async #ownedPlaytimes(steamid: string, appids: number[]): Promise<Map<number, number> | null> {
    // include_played_free_games: without it Steam omits a played free-to-play
    // game (e.g. Path of Exile, Warframe) from the response entirely, so an
    // owning friend would be misreported as a non-owner rather than an owner.
    // appids_filter has Steam return just these appids: ~77 bytes instead of a
    // whole library (~40 KB for 1009 games), per friend checked. A public
    // profile owning none of them still answers {game_count: 0}, while a
    // private one answers {} as before (both verified live), so
    // isPrivateOwnedGames tells them apart unchanged.
    const res = await this.#ownedGamesRaw(steamid, {
      include_appinfo: false,
      include_played_free_games: true,
      ...Object.fromEntries(appids.map((appid, i) => [`appids_filter[${i}]`, appid])),
    });
    if (isPrivateOwnedGames(res)) return null;
    const wanted = new Set(appids);
    const playtimes = new Map<number, number>();
    for (const g of res.response?.games ?? []) {
      if (typeof g.appid === "number" && wanted.has(g.appid))
        playtimes.set(g.appid, g.playtime_forever ?? 0);
    }
    return playtimes;
  }

  // ---- keyless-capable (key sent when present) ------------------------------

  // Not cached: reviews change as users post. Enums per Valve's
  // IUserReviewsService docs: filter helpful 0 / recent 1 / updated 2,
  // review_type all 0 / positive 1 / negative 2, purchase_type 1 = every buyer
  // (the default 0 is Steam purchases only). An empty `languages` means
  // english, not all. day_range only applies to helpful; Steam caps it at 365
  // and widens it on its own when the window has no reviews (verified live:
  // day_range 1 searched 30). A bad key is ignored here, not a 403 (verified
  // live).
  async getReviews(
    appid: number,
    max: number,
    reviewLanguage = "all",
    reviewType: "all" | "positive" | "negative" = "all",
    order: "helpful" | "recent" | "updated" = "helpful",
    withinDays?: number,
  ): Promise<Record<string, unknown>> {
    const res = await this.#call(Steam.GetAppReviews, {
      input_json: JSON.stringify({
        appid,
        num_per_page: max,
        languages: [reviewLanguage],
        review_type: { all: 0, positive: 1, negative: 2 }[reviewType],
        purchase_type: 1,
        filter: { helpful: 0, recent: 1, updated: 2 }[order],
        ...(order === "helpful" && withinDays !== undefined ? { day_range: withinDays } : {}),
      }),
    });
    return summarizeReviews(res, max);
  }

  // kind narrows the feed server-side (verified live on 6 games): "official"
  // keeps only the developer's own Steam announcements (the default list mixes
  // in third-party press feeds), "patch_notes" only posts the developer tagged
  // as patch notes.
  async getNews(
    appid: number,
    count: number,
    kind: "all" | "official" | "patch_notes" = "all",
  ): Promise<Record<string, unknown>> {
    const res = await this.#call(Steam.GetNewsForApp, {
      appid,
      count,
      maxlength: 400,
      ...(kind === "official" ? { feeds: "steam_community_announcements" } : {}),
      ...(kind === "patch_notes" ? { tags: "patchnotes" } : {}),
    });
    // A nonexistent appid's answer: a clean empty result.
    return summarizeNews(res.answer ? {} : res.data);
  }

  async getGlobalAchievements(appid: number): Promise<Record<string, unknown>> {
    const res = await this.#call(
      Steam.GetGlobalAchievementPercentagesForApp,
      { gameid: appid },
      { cache: true },
    );
    if (!res.answer) return summarizeGlobalAchievements(res.data);
    // "No data" is also the edge's passing 403 (clients/endpoints.ts). With a
    // key, the (cached) schema tells them apart: a game that lists
    // achievements has rarity data, so the answer was a failure. Keyless,
    // "no data" is the verified common reading.
    if (this.configured) {
      const schema = await optional(
        "Achievement schema (to tell 'no data' from a passing 403)",
        this.#call(Steam.GetSchemaForGame, { appid, l: this.#l }, { cache: true }),
      );
      if (schema?.data && hasAchievements(schema.data)) throw rarityBlocked(appid);
    }
    return summarizeGlobalAchievements({});
  }

  // Current concurrent player count for a game. Not cached — it's a live number.
  // `result` is Steam's own success flag: 1 = ok, anything else means the appid
  // wasn't found — as a 200, or as the endpoint's "no_app" answer (a 404).
  async getCurrentPlayers(appid: number): Promise<Record<string, unknown>> {
    const answered = await this.#call(Steam.GetNumberOfCurrentPlayers, { appid });
    const res: CurrentPlayersResponse = answered.answer ? {} : answered.data;
    if (res.response?.result !== 1) {
      throw new ApiError({
        code: "not_found",
        message: `GetNumberOfCurrentPlayers result ${res.response?.result} for appid ${appid}`,
        detail: `No Steam app with id ${appid}.`,
      });
    }
    return summarizeCurrentPlayers(res, appid);
  }

  // The modern store-browse/query card services (get_items, discover_games) live
  // on StoreServiceClient (clients/storeService.ts); tools/webStore.ts calls it
  // directly via this getter rather than through pass-through methods here.
  // Shares this.#get (one rate limiter, one cache), so it's built once in
  // the constructor and exposed, not reconstructed by the caller.
  get store(): StoreServiceClient {
    return this.#store;
  }

  // A player's wishlist (needs the wishlist/profile to be public). Keyless.
  async #getWishlistLight(steamid: string): Promise<Record<string, unknown>> {
    const res = await this.#call(Steam.GetWishlist, { steamid });
    return summarizeWishlist(res.answer ? {} : res.data);
  }

  // A player's followed games (needs the profile to be public). Keyless — a
  // separate opt-in "follow" feature from the wishlist; the count endpoint
  // reports the true total independent of any cap on the appid list.
  async getFollowedGames(steamid: string): Promise<Record<string, unknown>> {
    const [list, count] = await Promise.all([
      this.#followedGamesRaw(steamid),
      this.#followedGamesCount(steamid),
    ]);
    return summarizeFollowedGames(list, count);
  }

  async #followedGamesRaw(steamid: string): Promise<FollowedGamesResponse> {
    const res = await this.#call(Steam.GetGamesFollowed, { steamid });
    return res.answer ? {} : res.data;
  }

  // Optional: summarizeFollowedGames falls back to appids.length. Steam's own
  // count can exceed the list (32 listed, 33 counted on one profile, live
  // 2026-11-16), so a missing count is said, not hidden.
  async #followedGamesCount(steamid: string): Promise<FollowedGamesCountResponse> {
    const res = await optional(
      "Steam's own followed-games count (total is the listed games)",
      this.#call(Steam.GetGamesFollowedCount, { steamid }),
    );
    return res?.data ?? {};
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
  // the keyless global unlock % so each achievement carries its rarity. Both
  // requests are cached on their own (lib/cache.ts) and merged per call, so a
  // missing rarity costs only this answer — it is never cached as the schema.
  async getGameAchievements(appid: number, language?: string): Promise<Record<string, unknown>> {
    const l = language ?? this.#l;
    const [schema, rarity] = await Promise.all([
      this.#call(Steam.GetSchemaForGame, { appid, l }, { cache: true }),
      // Optional: the list stands without rarity. A failure is noted there.
      optional(
        "Achievement rarity (global unlock %)",
        this.#call(Steam.GetGlobalAchievementPercentagesForApp, { gameid: appid }, { cache: true }),
      ),
    ]);
    // Steam's answer for the appid itself (a nonexistent one).
    if (schema.answer) return summarizeGameSchema({}, {});
    if (rarity?.data) return summarizeGameSchema(schema.data, rarity.data);
    // Rarity's "no data" contradicts a schema that lists achievements: the
    // edge's passing 403, a gap to note — not Steam saying there's none.
    if (rarity?.answer && hasAchievements(schema.data)) {
      noteDegraded("Achievement rarity (global unlock %)", rarityBlocked(appid));
    }
    return summarizeGameSchema(schema.data, {});
  }
}
