// Pre-deploy health check for the upstream APIs this server depends on. Each
// check asserts a 200 (or another documented outcome — see the per-check
// comments) plus a minimal response shape, so a release can be gated against
// upstream drift. Wired into release.yml before packing.
//
// The Storefront and keyless Web API checks need no credentials. release.yml
// runs with no STEAM_API_KEY secret configured, so every "(key)" check below
// always skips there — they only run when a maintainer exports their own key
// and runs `npm run check:api` locally before a release.
//
// Run: `npm run check:api`.

const STORE = process.env.STEAM_STORE_BASE_URL ?? "https://store.steampowered.com";
const API = process.env.STEAM_API_BASE_URL ?? "https://api.steampowered.com";
// Not configurable in the server either — see clients/web.ts's constant.
const COMMUNITY = "https://steamcommunity.com";
const KEY = process.env.STEAM_API_KEY;
const SPACING_MS = 400;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const APPID = 620; // Portal 2 — stable, always present.

// Player-scoped checks can only confirm a populated payload on a profile whose
// game details are public; on a private one Steam answers a valid-but-empty
// shape, which proves the endpoint is up and nothing about its fields. Gabe
// Newell's profile used to be public and went friends-only by 2026-10-03, so a
// maintainer's own STEAM_ID (when it's a SteamID64) takes precedence. Checks
// that only ever saw the empty shape are listed at the end, so a pass can't
// silently mean "nothing was actually verified".
const GABE = "76561197960287930";
const PLAYER = /^\d{17}$/.test(process.env.STEAM_ID ?? "") ? process.env.STEAM_ID : GABE;
/** Names of checks that only saw a private-profile shape. */
const privateOnly: string[] = [];
/** Throws unless `cond`, naming the missing field. */
function need(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`missing ${what}`);
}
/**
 * Parses a response body as `T`. Unchecked: every field in these shapes is
 * optional/`unknown`, and each check asserts what it relies on itself.
 */
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
/** GET + 200 + JSON, the common prologue of every Web API check. */
const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
  return json<T>(res);
};

/** A chart rank's fields; each chart service fills a different subset. */
interface Rank {
  rank?: unknown;
  appid?: unknown;
  last_period_rank?: unknown;
  peak_in_game?: unknown;
  concurrent_in_game?: unknown;
  item?: { name?: unknown };
}
/** The `response` envelope the player-scoped Web API checks read. */
interface PlayerResponse {
  response?: Record<string, unknown>;
}
interface Check {
  name: string;
  skip?: string;
  run: () => Promise<void>;
}

// get_charts' player charts: names ride along on each rank's item only when a
// data_request is sent.
const CHART_INPUT = { context: { country_code: "US", language: "english" }, data_request: {} };

const checks: Check[] = [
  {
    name: "web IStoreQueryService/SearchSuggestions (search_games)",
    run: async () => {
      const input = {
        search_term: "portal",
        max_results: 3,
        context: { country_code: "US", language: "english" },
        data_request: {
          include_platforms: true,
          include_all_purchase_options: true,
          include_extra_details: true,
        },
      };
      const body = await getJson<{
        response?: {
          metadata?: { total_matching_records?: unknown };
          store_items?: {
            appid?: unknown;
            type?: unknown;
            purchase_options?: unknown;
            extra_details?: { metacritic?: { score?: unknown } };
          }[];
        };
      }>(
        `${API}/IStoreQueryService/SearchSuggestions/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`,
      );
      const it = body.response?.store_items?.[0];
      need(typeof body.response?.metadata?.total_matching_records === "number", "metadata.total");
      need(
        typeof it?.appid === "number" && typeof it.type === "number",
        "store_items[0].appid/type",
      );
      need(Array.isArray(it?.purchase_options), "store_items[0].purchase_options");
      need(typeof it?.extra_details?.metacritic?.score === "number", "extra_details.metacritic");
    },
  },
  {
    name: "storefront appdetails",
    run: async () => {
      const res = await fetch(`${STORE}/api/appdetails?appids=${APPID}&cc=US&l=english`, {
        headers: { Accept: "application/json" },
      });
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<Record<string, { success?: boolean; data?: { name?: string } }>>(res);
      const entry = body[String(APPID)];
      if (!entry?.success || !entry.data?.name) throw new Error("missing success/data.name");
    },
  },
  {
    name: "storefront appreviews",
    run: async () => {
      const res = await fetch(`${STORE}/appreviews/${APPID}?json=1&num_per_page=1`, {
        headers: { Accept: "application/json" },
      });
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<{ success?: unknown; query_summary?: unknown }>(res);
      if (body.success !== 1 || !body.query_summary) throw new Error("missing query_summary");
    },
  },
  {
    name: "web GetGlobalAchievementPercentagesForApp",
    run: async () => {
      const res = await fetch(
        `${API}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${APPID}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<{ achievementpercentages?: { achievements?: unknown } }>(res);
      if (!Array.isArray(body.achievementpercentages?.achievements))
        throw new Error("missing achievementpercentages.achievements");
    },
  },
  {
    name: "web GetPlayerSummaries (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(
        `${API}/ISteamUser/GetPlayerSummaries/v2/?key=${KEY}&steamids=${PLAYER}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<{
        response?: { players?: { communityvisibilitystate?: unknown }[] };
      }>(res);
      if (!Array.isArray(body.response?.players)) throw new Error("missing response.players");
      need(
        typeof body.response.players[0]?.communityvisibilitystate === "number",
        "players[0].communityvisibilitystate",
      );
    },
  },
  {
    // Game-details visibility (owned games, recent playtime, level) isn't
    // guaranteed public on any profile — Steam answers 200 with an
    // empty `response: {}` in that case, which is a valid, documented shape
    // (see clients/web.ts isPrivate()), not a broken endpoint. So this accepts
    // EITHER shape and only fails on a genuinely malformed/missing `response`.
    name: "web GetOwnedGames (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(
        `${API}/IPlayerService/GetOwnedGames/v1/?key=${KEY}&steamid=${PLAYER}&include_appinfo=true`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<{
        response?: { game_count?: unknown; games?: { playtime_forever?: unknown }[] };
      }>(res);
      if (typeof body.response !== "object" || body.response === null)
        throw new Error("missing response object");
      if (Object.keys(body.response).length === 0) return void privateOnly.push("GetOwnedGames");
      need(typeof body.response.game_count === "number", "response.game_count");
      need(
        typeof body.response.games?.[0]?.playtime_forever === "number",
        "games[0].playtime_forever",
      );
    },
  },
  {
    // Same privacy caveat as GetOwnedGames above.
    name: "web GetRecentlyPlayedGames (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(
        `${API}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${KEY}&steamid=${PLAYER}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<PlayerResponse>(res);
      if (typeof body.response !== "object" || body.response === null)
        throw new Error("missing response object");
      if (Object.keys(body.response).length === 0)
        return void privateOnly.push("GetRecentlyPlayedGames");
      need(typeof body.response.total_count === "number", "response.total_count");
    },
  },
  {
    // GetSteamLevel has its own independent failure mode (e.g. private
    // inventory) — same dual-shape acceptance as GetOwnedGames.
    name: "web GetSteamLevel (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(
        `${API}/IPlayerService/GetSteamLevel/v1/?key=${KEY}&steamid=${PLAYER}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<PlayerResponse>(res);
      if (typeof body.response !== "object" || body.response === null)
        throw new Error("missing response object");
      if (Object.keys(body.response).length === 0) return void privateOnly.push("GetSteamLevel");
      need(typeof body.response.player_level === "number", "response.player_level");
    },
  },
  {
    // A private friends list answers 401/403 (see clients/web.ts #friendsRaw) —
    // that's a valid, documented outcome, not downtime, so it's accepted
    // alongside the normal 200 shape. Anything else (5xx, network, bad JSON) fails.
    name: "web GetFriendList (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(
        `${API}/ISteamUser/GetFriendList/v1/?key=${KEY}&steamid=${PLAYER}&relationship=friend`,
        { headers: { Accept: "application/json" } },
      );
      // private friends list — healthy, but nothing about the fields was seen
      if (res.status === 401 || res.status === 403) return void privateOnly.push("GetFriendList");
      if (res.status !== 200)
        throw new Error(`expected 200 (or 401/403 private), got ${res.status}`);
      const body = await json<{ friendslist?: unknown }>(res);
      if (typeof body.friendslist !== "object" || body.friendslist === null)
        throw new Error("missing friendslist object");
    },
  },
  {
    // Ban status isn't privacy-gated, so this can assert the full shape strictly.
    name: "web GetPlayerBans (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(`${API}/ISteamUser/GetPlayerBans/v1/?key=${KEY}&steamids=${PLAYER}`, {
        headers: { Accept: "application/json" },
      });
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<{ players?: { VACBanned?: unknown }[] }>(res);
      if (!Array.isArray(body.players) || typeof body.players[0]?.VACBanned !== "boolean")
        throw new Error("missing players[0].VACBanned");
    },
  },
  {
    // Vanity resolution isn't privacy-gated either — a fixed, well-known vanity
    // name always resolves the same way, so this can assert strictly too.
    name: "web ResolveVanityURL (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(
        `${API}/ISteamUser/ResolveVanityURL/v1/?key=${KEY}&vanityurl=gabelogannewell`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<{ response?: { success?: unknown; steamid?: unknown } }>(res);
      if (body.response?.success !== 1 || typeof body.response?.steamid !== "string")
        throw new Error("missing response.steamid");
    },
  },
  {
    // A game's achievement schema is a static asset, not tied to any player —
    // no privacy caveat here either.
    name: "web GetSchemaForGame (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(
        `${API}/ISteamUserStats/GetSchemaForGame/v2/?key=${KEY}&appid=${APPID}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<{ game?: { availableGameStats?: { achievements?: unknown } } }>(res);
      if (!Array.isArray(body.game?.availableGameStats?.achievements))
        throw new Error("missing game.availableGameStats.achievements");
    },
  },
  {
    name: "web IStoreBrowseService/GetItems (compat + tags)",
    run: async () => {
      // Guards the platforms.* compat enums and the tag list get_items /
      // discover_games surface: steam_deck (long-standing) plus steam_os (SteamOS)
      // and steam_frame (Steam Frame VR), and popular user tags (tagids resolved
      // via GetTagList below). Portal 2 carries all of them; a drift that drops one
      // should fail the release, not silently blank the field.
      const input = {
        ids: [{ appid: APPID }],
        context: { language: "english", country_code: "US" },
        data_request: { include_platforms: true, include_tag_count: 5 },
      };
      const res = await fetch(
        `${API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<{
        response?: {
          store_items?: { platforms?: Record<string, unknown>; tags?: { tagid?: unknown }[] }[];
        };
      }>(res);
      const item = body.response?.store_items?.[0];
      const platforms = item?.platforms;
      if (!platforms) throw new Error("missing store_items[0].platforms");
      for (const field of [
        "steam_deck_compat_category",
        "steam_os_compat_category",
        "steam_frame_compat_category",
      ]) {
        if (typeof platforms[field] !== "number") throw new Error(`missing platforms.${field}`);
      }
      if (!Array.isArray(item?.tags) || typeof item.tags[0]?.tagid !== "number")
        throw new Error("missing store_items[0].tags[].tagid");
    },
  },
  {
    name: "web IStoreService/GetTagList (tag names)",
    run: async () => {
      // The keyless tag dictionary that resolves store_items' numeric tagids to
      // readable names. Without it get_items / discover_games would emit empty tags.
      const res = await fetch(`${API}/IStoreService/GetTagList/v1/?language=english`, {
        headers: { Accept: "application/json" },
      });
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<{ response?: { tags?: { tagid?: unknown; name?: unknown }[] } }>(res);
      const tags = body.response?.tags;
      if (!Array.isArray(tags) || !tags.length) throw new Error("missing response.tags");
      if (typeof tags[0]?.tagid !== "number" || typeof tags[0]?.name !== "string")
        throw new Error("tags[] missing tagid/name");
    },
  },
  {
    name: "web IWishlistService/GetWishlistSortedFiltered (enriched wishlist)",
    run: async () => {
      // Guards the shape get_wishlist's include_details relies on: each item
      // embeds a store_item card (same shape as GetItems). Uses the maintainer's
      // own public wishlist (stable, non-empty) so the check exercises the real
      // nested store_item fields, not just the top-level envelope.
      const WISHLIST_STEAMID = "76561198040603064";
      const input = {
        steamid: WISHLIST_STEAMID,
        context: { language: "english", country_code: "US" },
        data_request: { include_basic_info: true },
      };
      const res = await fetch(
        `${API}/IWishlistService/GetWishlistSortedFiltered/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<{
        response?: { items?: { appid?: unknown; store_item?: { appid?: unknown } }[] };
      }>(res);
      const items = body.response?.items;
      if (!Array.isArray(items) || !items.length)
        throw new Error("missing response.items — is the test wishlist still public/non-empty?");
      const item = items[0];
      if (typeof item?.appid !== "number") throw new Error("missing items[0].appid");
      if (typeof item.store_item?.appid !== "number")
        throw new Error("missing items[0].store_item.appid");
    },
  },
  {
    name: "web IStoreQueryService/Query (discover)",
    run: async () => {
      const input = {
        query: { start: 0, count: 1, filters: { price_filters: { min_discount_percent: 80 } } },
        context: { language: "english", country_code: "US", steam_realm: 1 },
        data_request: { include_basic_info: true },
      };
      const res = await fetch(
        `${API}/IStoreQueryService/Query/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await json<{ response?: { metadata?: { total_matching_records?: unknown } } }>(
        res,
      );
      if (typeof body.response?.metadata?.total_matching_records !== "number")
        throw new Error("missing metadata.total_matching_records");
    },
  },
  {
    name: "community profile XML (keyless vanity resolution)",
    run: async () => {
      // The one non-API host this server uses: clients/web.ts resolves a vanity
      // STEAM_ID through <steamID64> here when no key is set, so get_wishlist and
      // get_followed_games keep working without one. Uses Valve's own well-known
      // vanity ("gabelogannewell") rather than a personal profile.
      const res = await fetch(`${COMMUNITY}/id/gabelogannewell/?xml=1`, {
        headers: { Accept: "*/*" },
      });
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const xml = await res.text();
      if (!/<steamID64>\d{17}<\/steamID64>/.test(xml))
        throw new Error("missing <steamID64> in the profile XML");
    },
  },
  {
    name: "storefront featuredcategories",
    run: async () => {
      const body = await getJson<Record<string, { items?: { type?: unknown }[] } | undefined>>(
        `${STORE}/api/featuredcategories?cc=US&l=english`,
      );
      for (const k of ["specials", "top_sellers", "new_releases", "coming_soon"])
        need(Array.isArray(body[k]?.items), `${k}.items`);
      // format/storefront.ts's featuredItems() keeps only type 0 (apps): a
      // top_sellers bundle arrives as type 2 with a bundle id in `id`.
      need(typeof body.top_sellers?.items?.[0]?.type === "number", "top_sellers.items[0].type");
    },
  },
  {
    name: "storefront appreviewhistogram",
    run: async () => {
      const body = await getJson<{
        success?: unknown;
        results?: { rollups?: unknown; recent?: unknown };
      }>(`${STORE}/appreviewhistogram/${APPID}?l=english`);
      need(body.success === 1 && Array.isArray(body.results?.rollups), "results.rollups");
      need(Array.isArray(body.results.recent), "results.recent");
    },
  },
  {
    name: "web GetNewsForApp",
    run: async () => {
      const body = await getJson<{ appnews?: { newsitems?: unknown } }>(
        `${API}/ISteamNews/GetNewsForApp/v2/?appid=${APPID}&count=1&maxlength=50`,
      );
      need(Array.isArray(body.appnews?.newsitems), "appnews.newsitems");
    },
  },
  {
    name: "web GetNumberOfCurrentPlayers",
    run: async () => {
      const body = await getJson<{ response?: { player_count?: unknown } }>(
        `${API}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${APPID}`,
      );
      need(typeof body.response?.player_count === "number", "response.player_count");
    },
  },
  {
    // A non-public profile answers 403 with playerstats.error — the endpoint's
    // documented private shape (clients/web.ts handles it), not downtime.
    name: "web GetPlayerAchievements (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(
        `${API}/ISteamUserStats/GetPlayerAchievements/v1/?key=${KEY}&steamid=${PLAYER}&appid=${APPID}`,
        { headers: { Accept: "application/json" } },
      );
      const body = await json<{ playerstats?: { error?: unknown; success?: unknown } }>(res);
      if (res.status === 403 && typeof body.playerstats?.error === "string")
        return void privateOnly.push("GetPlayerAchievements");
      if (res.status === 400 && body.playerstats?.success === false) return; // doesn't own it
      if (res.status !== 200) throw new Error(`expected 200 (or 403 private), got ${res.status}`);
      need(body.playerstats?.success === true, "playerstats.success");
    },
  },
  {
    // The keyless player endpoints answer `{response:{}}` for a private (or
    // empty) wishlist/follow list — healthy, just unverifiable.
    name: "web IWishlistService/GetWishlist",
    run: async () => {
      const body = await getJson<{
        response?: { items?: { appid?: unknown }[] };
      }>(`${API}/IWishlistService/GetWishlist/v1/?steamid=${PLAYER}`);
      need(typeof body.response === "object" && body.response !== null, "response object");
      if (!Array.isArray(body.response.items)) return void privateOnly.push("GetWishlist");
      need(typeof body.response.items[0]?.appid === "number", "items[0].appid");
    },
  },
  {
    name: "web IStoreService/GetGamesFollowed",
    run: async () => {
      const body = await getJson<PlayerResponse>(
        `${API}/IStoreService/GetGamesFollowed/v1/?steamid=${PLAYER}`,
      );
      need(typeof body.response === "object" && body.response !== null, "response object");
      if (!Array.isArray(body.response.appids)) privateOnly.push("GetGamesFollowed");
    },
  },
  {
    name: "web IStoreService/GetGamesFollowedCount",
    run: async () => {
      const body = await getJson<PlayerResponse>(
        `${API}/IStoreService/GetGamesFollowedCount/v1/?steamid=${PLAYER}`,
      );
      need(typeof body.response === "object" && body.response !== null, "response object");
      if (typeof body.response.followed_game_count !== "number")
        privateOnly.push("GetGamesFollowedCount");
    },
  },
  {
    name: "web IStoreTopSellersService/GetWeeklyTopSellers (charts)",
    run: async () => {
      const input = { context: { country_code: "US", language: "english" }, page_count: 3 };
      const body = await getJson<{ response?: { start_date?: unknown; ranks?: Rank[] } }>(
        `${API}/IStoreTopSellersService/GetWeeklyTopSellers/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`,
      );
      const r = body.response?.ranks?.[0];
      need(typeof body.response?.start_date === "number", "response.start_date");
      need(typeof r?.rank === "number" && typeof r.appid === "number", "ranks[0].rank/appid");
    },
  },
  {
    name: "web ISteamChartsService/GetMostPlayedGames (charts)",
    run: async () => {
      const body = await getJson<{ response?: { rollup_date?: unknown; ranks?: Rank[] } }>(
        `${API}/ISteamChartsService/GetMostPlayedGames/v1/?input_json=${encodeURIComponent(JSON.stringify(CHART_INPUT))}`,
      );
      const r = body.response?.ranks?.[0];
      need(typeof body.response?.rollup_date === "number", "response.rollup_date");
      need(typeof r?.appid === "number" && typeof r.peak_in_game === "number", "ranks[0]");
      need(typeof r?.item?.name === "string", "ranks[0].item.name");
    },
  },
  {
    name: "web ISteamChartsService/GetMostPlayedSteamDeckGames (charts)",
    run: async () => {
      const input = {
        context: { country_code: "US", language: "english" },
        data_request: {},
        top_played_period: 1,
        count: 3,
      };
      const body = await getJson<{ response?: { ranks?: Rank[] } }>(
        `${API}/ISteamChartsService/GetMostPlayedSteamDeckGames/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`,
      );
      const r = body.response?.ranks?.[0];
      need(typeof r?.rank === "number" && typeof r.appid === "number", "ranks[0].rank/appid");
      need(typeof r?.item?.name === "string", "ranks[0].item.name");
      need(typeof r?.last_period_rank === "number", "ranks[0].last_period_rank");
    },
  },
  {
    name: "web ISteamChartsService/GetGamesByConcurrentPlayers (charts)",
    run: async () => {
      const body = await getJson<{ response?: { last_update?: unknown; ranks?: Rank[] } }>(
        `${API}/ISteamChartsService/GetGamesByConcurrentPlayers/v1/?input_json=${encodeURIComponent(JSON.stringify(CHART_INPUT))}`,
      );
      const r = body.response?.ranks?.[0];
      need(typeof body.response?.last_update === "number", "response.last_update");
      need(typeof r?.appid === "number" && typeof r.concurrent_in_game === "number", "ranks[0]");
      need(typeof r?.item?.name === "string", "ranks[0].item.name");
    },
  },
];

const failures: string[] = [];
let ran = 0;
for (const check of checks) {
  if (check.skip) {
    console.log(`  skip ${check.name} (${check.skip})`);
    continue;
  }
  ran += 1;
  try {
    await check.run();
    console.log(`  ok   ${check.name}`);
  } catch (err) {
    failures.push(check.name);
    console.error(`  FAIL ${check.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await delay(SPACING_MS);
}

if (failures.length) {
  console.error(`\n${failures.length}/${ran} API checks failed.`);
  process.exit(1);
}
console.log(`\nAll ${ran} API check(s) passed${ran < checks.length ? " (some skipped)" : ""}.`);
if (privateOnly.length)
  console.log(
    `Note: ${privateOnly.join(", ")} only returned a private/empty shape for ${PLAYER}, so ` +
      "their fields went unverified. Set STEAM_ID to a SteamID64 with public game details " +
      "to check them.",
  );
