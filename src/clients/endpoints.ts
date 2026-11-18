// Every Steam endpoint this server calls, with what we know about it — the
// single place a fact about Steam is stated (lib/endpoint.ts says how it's
// used). Each answer and body rule has a probe: a live call that
// shows it, run by `npm run check:api`. A fact here without a probe is a
// guess; a probe that starts failing means Steam changed.
//
// Probe ids, all public: 620 Portal 2; 1206340 a DLC with no achievement
// schema; 99999999 no such app; 76561197960265728 accountid 0 (no account,
// the one SteamID64 Steam answers 400 for); 76561197960287930 a friends-only
// profile; 76561197960435530 a profile with private game details;
// 76561198028121353 a public profile; 76561199999999999 no such account.
import { endpoint } from "../lib/endpoint.ts";
import type {
  CurrentPlayersResponse,
  FollowedGamesCountResponse,
  FollowedGamesResponse,
  FriendListResponse,
  NewsResponse,
  OwnedGamesResponse,
  PlayerBansResponse,
  PlayerSummariesResponse,
  RecentlyPlayedResponse,
  ReviewsResponse,
  SteamLevelResponse,
  VanityResponse,
  WishlistResponse,
} from "../format/web.ts";
import type {
  GameSchemaResponse,
  GlobalAchievementsResponse,
  PlayerAchievementsResponse,
} from "../format/webAchievements.ts";
import type {
  SearchSuggestionsResponse,
  StoreQueryResponse,
  WishlistDetailedResponse,
} from "../format/store.ts";
import {
  summarizeTagList,
  type GetTagListResponse,
  type StoreItemsResponse,
} from "../format/storeCard.ts";
import { summarizePurchasePrices } from "../format/store.ts";
import type {
  ConcurrentPlayersResponse,
  DeckMostPlayedResponse,
  MostPlayedResponse,
  TopSellersResponse,
} from "../format/charts.ts";
import type { FeaturedResponse, ReviewHistogramResponse, StoreApp } from "../format/storefront.ts";
import { ApiError } from "../lib/errors.ts";

const PUBLIC = "76561198028121353";
// Stands for the maintainer's STEAM_ID, filled in by check:api from the
// environment: a probe that needs a profile in a state the maintainer
// controls, without putting that id in the repo.
export const MAINTAINER = "$STEAM_ID";
const ACCOUNT_0 = "76561197960265728";
const json = (o: unknown) => JSON.stringify(o);
const ctx = { language: "english", country_code: "US" };

// accountid 0 names no account: Steam answers it with a 400 HTML page on
// every player endpoint keyed on one SteamID64. The tools refuse it before
// any call (tools/webShared.ts), so the 400 stays an error, never an answer —
// read as one, it also covered every other 400 (e.g. a missing key).
const invalidSteamidProbe = (query: Record<string, string | number>) => ({
  query,
  expect: "bad_request",
  shows: "accountid 0 is a 400",
  situation: "accountid-0",
});

// Steam's page for a bad/revoked key, shown on each key-gated endpoint with a
// deliberately invalid key; its status differs by endpoint (see below), so
// each endpoint records its own.
const badKeyProbe = (query: Record<string, string | number>) => ({
  query,
  badKey: true,
  expect: "invalid_key",
  shows: "a bad key's page",
  situation: "bad-key",
});

// A bad/revoked key gets this HTML page on every key-gated endpoint ("Access
// is denied. Retrying will not help. Please verify your <pre>key=</pre>
// parameter.") — a 401 or a 403 by endpoint, not by interface: GetOwnedGames
// sends 401, GetRecentlyPlayedGames 403, both IPlayerService (each endpoint's
// bad-key probe records which; the 401 once went unclassified while only 403
// was checked, and a test fixture then guessed 401 for all of IPlayerService). The same
// statuses a private profile gets, never its JSON body. Classified as its own
// code where the response is read (HttpClient's `classify`), before retries,
// the cache and any endpoint answer act on it. (Keyless endpoints ignore a
// bad key and answer 200, also verified live.)
export function classifySteamApiError(err: ApiError, body: string): ApiError {
  if (err.code !== "forbidden" && err.code !== "unauthorized") return err;
  if (!/verify your <pre>key=/i.test(body)) return err;
  return new ApiError({
    code: "invalid_key",
    status: err.status,
    message: err.message,
    cause: err,
  });
}

/** appdetails, keyed by appid; `data` is `[]` for some delisted apps. */
export type AppDetailsResponse = Record<string, { success?: boolean; data?: StoreApp | [] }>;

export const Steam = {
  // ---- player data (key required) ------------------------------------------
  ResolveVanityURL: endpoint<VanityResponse>({
    path: "ISteamUser/ResolveVanityURL/v1/",
    host: "api",
    keyless: false,
    probes: [
      { query: { vanityurl: "gabelogannewell" }, expect: "data", shows: "resolves" },
      badKeyProbe({ vanityurl: "gabelogannewell" }),
    ],
  }),
  GetPlayerSummaries: endpoint<PlayerSummariesResponse>({
    path: "ISteamUser/GetPlayerSummaries/v2/",
    host: "api",
    keyless: false,
    probes: [
      { query: { steamids: PUBLIC }, expect: "data", shows: "a public profile" },
      badKeyProbe({ steamids: PUBLIC }),
      // Unlike the per-player endpoints, no account is a 200 with no players.
      {
        query: { steamids: ACCOUNT_0 },
        expect: "data",
        shows: "accountid 0 is an empty 200",
        situation: "accountid-0",
      },
    ],
  }),
  GetPlayerBans: endpoint<PlayerBansResponse>({
    path: "ISteamUser/GetPlayerBans/v1/",
    host: "api",
    keyless: false,
    probes: [
      {
        query: { steamids: ACCOUNT_0 },
        expect: "data",
        shows: "accountid 0 is an empty 200",
        situation: "accountid-0",
      },
    ],
  }),
  GetSteamLevel: endpoint<SteamLevelResponse>({
    path: "IPlayerService/GetSteamLevel/v1/",
    host: "api",
    keyless: false,
    probes: [invalidSteamidProbe({ steamid: ACCOUNT_0 })],
  }),
  GetOwnedGames: endpoint<OwnedGamesResponse>({
    path: "IPlayerService/GetOwnedGames/v1/",
    host: "api",
    keyless: false,
    probes: [
      { query: { steamid: PUBLIC }, expect: "data", shows: "a public library" },
      invalidSteamidProbe({ steamid: ACCOUNT_0 }),
      badKeyProbe({ steamid: PUBLIC }),
    ],
  }),
  GetRecentlyPlayedGames: endpoint<RecentlyPlayedResponse>({
    path: "IPlayerService/GetRecentlyPlayedGames/v1/",
    host: "api",
    keyless: false,
    probes: [
      invalidSteamidProbe({ steamid: ACCOUNT_0, count: 1 }),
      badKeyProbe({ steamid: PUBLIC, count: 1 }),
    ],
  }),
  // A private list and a missing account answer alike, so one answer for both.
  // Never a plain 403 (only the bad-key page): 36 of 36 non-public profiles
  // sampled live 2026-11-17 answered 401.
  GetFriendList: endpoint<FriendListResponse, "not_shown">({
    path: "ISteamUser/GetFriendList/v1/",
    host: "api",
    keyless: false,
    answers: {
      unauthorized: "not_shown",
      not_found: "not_shown",
    },
    probes: [
      badKeyProbe({ steamid: PUBLIC, relationship: "friend" }),
      {
        query: { steamid: "76561197960287930", relationship: "friend" },
        expect: "not_shown",
        shows: "a friends-only list is a 401",
        situation: "friends-only",
      },
      {
        query: { steamid: "76561199999999999", relationship: "friend" },
        expect: "not_shown",
        shows: "no such account is a 404",
        situation: "no-account",
      },
      {
        query: { steamid: ACCOUNT_0, relationship: "friend" },
        expect: "bad_request",
        shows: "accountid 0 is a 400",
        situation: "accountid-0",
      },
    ],
  }),
  // Hidden game details are always a 403 "Profile is not public" — never a 401
  // or 404 (44 of 44 sampled live 2026-11-17), and so is an id with no account
  // (3 of 3). A 400 ("Requested app has no stats") comes for an app without
  // stats and for an unknown appid alike; the schema tells them apart.
  GetPlayerAchievements: endpoint<PlayerAchievementsResponse, "not_shown" | "no_stats">({
    path: "ISteamUserStats/GetPlayerAchievements/v1/",
    host: "api",
    keyless: false,
    answers: { forbidden: "not_shown", bad_request: "no_stats" },
    probes: [
      badKeyProbe({ steamid: PUBLIC, appid: 620 }),
      {
        query: { steamid: "76561197960435530", appid: 620 },
        expect: "not_shown",
        shows: "private game details are a 403",
        situation: "private-game-details",
      },
      {
        // The maintainer's own public profile (STEAM_ID, never committed),
        // which doesn't own ELDEN RING: Steam's 403 says "Profile is not
        // public" for a game the player simply doesn't have.
        query: { steamid: MAINTAINER, appid: 1245620 },
        expect: "not_shown",
        shows: "a public profile without the game is the same 403",
        situation: "game-not-owned",
      },
      {
        query: { steamid: PUBLIC, appid: 228980 },
        expect: "no_stats",
        shows: "an app without stats is a 400",
        situation: "app-without-stats",
      },
      {
        query: { steamid: PUBLIC, appid: 99999999 },
        expect: "no_stats",
        shows: "an unknown appid is the same 400",
        situation: "unknown-appid",
      },
    ],
  }),
  // Needs the key. A DLC without a schema is a 200 with an empty `game`; a
  // nonexistent appid a 400. Its 403 is only ever the bad-key page.
  GetSchemaForGame: endpoint<GameSchemaResponse, "no_schema">({
    path: "ISteamUserStats/GetSchemaForGame/v2/",
    host: "api",
    keyless: false,
    answers: { bad_request: "no_schema" },
    probes: [
      {
        query: { appid: 1206340 },
        expect: "data",
        shows: "a schema-less DLC is an empty 200",
        situation: "schema-less-dlc",
      },
      {
        query: { appid: 99999999 },
        expect: "no_schema",
        shows: "no such app is a 400",
        situation: "no-app",
      },
      badKeyProbe({ appid: 620 }),
    ],
  }),

  // ---- keyless-capable (key sent when present) ------------------------------
  // A 403 for a DLC with no achievement data and for a nonexistent appid
  // (never a 400/404: five such appids sampled live 2026-11-17). Never seen for
  // a game that has data: every such game sampled answered 200, and Steam under
  // load answers 420 (rate_limited), not 403.
  GetGlobalAchievementPercentagesForApp: endpoint<GlobalAchievementsResponse, "no_data">({
    path: "ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/",
    host: "api",
    keyless: true,
    answers: { forbidden: "no_data" },
    probes: [
      { query: { gameid: 620 }, expect: "data", shows: "a game with achievements" },
      {
        query: { gameid: 1206340 },
        expect: "no_data",
        shows: "a schema-less DLC is a 403",
        situation: "schema-less-dlc",
      },
      {
        query: { gameid: 99999999 },
        expect: "no_data",
        shows: "no such app is a 403",
        situation: "no-app",
      },
    ],
  }),
  GetNumberOfCurrentPlayers: endpoint<CurrentPlayersResponse, "no_app">({
    path: "ISteamUserStats/GetNumberOfCurrentPlayers/v1/",
    host: "api",
    keyless: true,
    answers: { not_found: "no_app" },
    probes: [
      { query: { appid: 620 }, expect: "data", shows: "a live count" },
      {
        query: { appid: 99999999 },
        expect: "no_app",
        shows: "no such app is a 404",
        situation: "no-app",
      },
    ],
  }),
  GetNewsForApp: endpoint<NewsResponse, "unknown_appid">({
    path: "ISteamNews/GetNewsForApp/v2/",
    host: "api",
    keyless: true,
    answers: { forbidden: "unknown_appid" },
    probes: [
      { query: { appid: 620, count: 1 }, expect: "data", shows: "news" },
      {
        query: { appid: 99999999, count: 1 },
        expect: "unknown_appid",
        shows: "no such app is a 403",
        situation: "no-app",
      },
    ],
  }),
  GetAppReviews: endpoint<{ response?: ReviewsResponse }>({
    path: "IUserReviewsService/GetAppReviews/v1/",
    host: "api",
    keyless: true,
    probes: [
      {
        query: { input_json: json({ appid: 620, num_per_page: 1 }) },
        expect: "data",
        shows: "reviews",
      },
    ],
  }),
  GetWishlist: endpoint<WishlistResponse>({
    path: "IWishlistService/GetWishlist/v1/",
    host: "api",
    keyless: true,
    probes: [invalidSteamidProbe({ steamid: ACCOUNT_0 })],
  }),
  GetWishlistSortedFiltered: endpoint<WishlistDetailedResponse>({
    path: "IWishlistService/GetWishlistSortedFiltered/v1/",
    host: "api",
    keyless: true,
    probes: [invalidSteamidProbe({ input_json: json({ steamid: ACCOUNT_0 }) })],
  }),
  GetGamesFollowed: endpoint<FollowedGamesResponse>({
    path: "IStoreService/GetGamesFollowed/v1/",
    host: "api",
    keyless: true,
    probes: [invalidSteamidProbe({ steamid: ACCOUNT_0 })],
  }),
  GetGamesFollowedCount: endpoint<FollowedGamesCountResponse>({
    path: "IStoreService/GetGamesFollowedCount/v1/",
    host: "api",
    keyless: true,
    probes: [invalidSteamidProbe({ steamid: ACCOUNT_0 })],
  }),
  // An unrecognized `language` (an ISO code like "ru" instead of "russian") is
  // a 200 with an empty dictionary — no language has zero tags: a request
  // problem.
  GetTagList: endpoint<GetTagListResponse>({
    path: "IStoreService/GetTagList/v1/",
    host: "api",
    keyless: true,
    validate: (body, query) => {
      if (Object.keys(summarizeTagList(body)).length > 0) return;
      // The hint lives on the error itself, so every path that reports it —
      // a tags filter, recommendations, a "Game tags" note — says how to fix it.
      throw new ApiError({
        code: "bad_request",
        message: `Steam returned an empty tag dictionary for language "${query.language}"`,
        detail:
          `Steam has no tag dictionary for language "${query.language}": use one of Steam's ` +
          "full language names (english, russian, schinese — not an ISO code like en/ru/zh).",
      });
    },
    probes: [
      { query: { language: "english" }, expect: "data", shows: "a dictionary" },
      {
        query: { language: "ru" },
        expect: "bad_request",
        shows: "an ISO code is an empty 200",
        situation: "iso-language",
      },
    ],
  }),
  GetItems: endpoint<StoreItemsResponse>({
    path: "IStoreBrowseService/GetItems/v1/",
    host: "api",
    keyless: true,
    probes: [
      {
        query: { input_json: json({ ids: [{ appid: 620 }], context: ctx }) },
        expect: "data",
        shows: "items",
      },
    ],
  }),
  // GetItems asked only for purchase options (data_request
  // include_all_purchase_options), feeding a price correction: a body that
  // doesn't fit the price shape fails like a request and is never cached. Not
  // retryable (the same body fails the same way), so it costs that chunk's
  // correction, noted. Its own entry because the rule holds for that query's
  // URL, not for every GetItems answer.
  GetPurchaseOptions: endpoint<StoreItemsResponse>({
    path: "IStoreBrowseService/GetItems/v1/",
    host: "api",
    keyless: true,
    validate: (body) => void summarizePurchasePrices(body),
    probes: [
      {
        query: {
          input_json: json({
            ids: [{ appid: 3717330 }],
            context: ctx,
            data_request: { include_all_purchase_options: true },
          }),
        },
        expect: "data",
        shows: "purchase options that fit the price shape",
      },
    ],
  }),
  Query: endpoint<StoreQueryResponse>({
    path: "IStoreQueryService/Query/v1/",
    host: "api",
    keyless: true,
    probes: [
      {
        query: { input_json: json({ query: { count: 1 }, context: ctx }) },
        expect: "data",
        shows: "a page",
      },
    ],
  }),
  SearchSuggestions: endpoint<SearchSuggestionsResponse>({
    path: "IStoreQueryService/SearchSuggestions/v1/",
    host: "api",
    keyless: true,
    probes: [
      {
        query: { input_json: json({ search_term: "portal", max_results: 1, context: ctx }) },
        expect: "data",
        shows: "suggestions",
      },
    ],
  }),
  GetWeeklyTopSellers: endpoint<TopSellersResponse>({
    path: "IStoreTopSellersService/GetWeeklyTopSellers/v1/",
    host: "api",
    keyless: true,
    probes: [
      {
        query: { input_json: json({ context: ctx, page_count: 1 }) },
        expect: "data",
        shows: "a chart",
      },
    ],
  }),
  GetMostPlayedSteamDeckGames: endpoint<DeckMostPlayedResponse>({
    path: "ISteamChartsService/GetMostPlayedSteamDeckGames/v1/",
    host: "api",
    keyless: true,
    probes: [
      {
        query: { input_json: json({ context: ctx, top_played_period: 1, count: 1 }) },
        expect: "data",
        shows: "a chart",
      },
    ],
  }),
  GetMostPlayedGames: endpoint<MostPlayedResponse>({
    path: "ISteamChartsService/GetMostPlayedGames/v1/",
    host: "api",
    keyless: true,
    probes: [{ query: { input_json: json({ context: ctx }) }, expect: "data", shows: "a chart" }],
  }),
  GetGamesByConcurrentPlayers: endpoint<ConcurrentPlayersResponse>({
    path: "ISteamChartsService/GetGamesByConcurrentPlayers/v1/",
    host: "api",
    keyless: true,
    probes: [{ query: { input_json: json({ context: ctx }) }, expect: "data", shows: "a chart" }],
  }),

  // ---- store.steampowered.com (keyless) -------------------------------------
  // appdetails answers every appid it's asked about, a nonexistent one too
  // ({success:false}; the only omission seen is appid 0, which no tool schema
  // accepts). So a body without an entry for each requested appid is
  // unusable: retried, never cached, a stale copy stands in.
  AppDetails: endpoint<AppDetailsResponse>({
    path: "api/appdetails",
    host: "store",
    keyless: true,
    validate: (body, query) => {
      const ids = String(query.appids).split(",");
      const missing = ids.filter((id) => !(id in body));
      if (missing.length === 0) return;
      throw new ApiError({
        code: "bad_response",
        message: `appdetails answered without an entry for ${missing.length} of ${ids.length} appids`,
        retryable: true,
      });
    },
    probes: [
      {
        query: { appids: "620,99999999", filters: "price_overview" },
        expect: "data",
        shows: "an entry for every appid, {success:false} for a nonexistent one",
      },
    ],
  }),
  ReviewHistogram: endpoint<ReviewHistogramResponse>({
    path: "appreviewhistogram/{appid}",
    host: "store",
    keyless: true,
    probes: [{ query: { appid: 620, l: "english" }, expect: "data", shows: "a histogram" }],
  }),
  FeaturedCategories: endpoint<FeaturedResponse>({
    path: "api/featuredcategories",
    host: "store",
    keyless: true,
    probes: [{ query: { cc: "US" }, expect: "data", shows: "store sections" }],
  }),
};
