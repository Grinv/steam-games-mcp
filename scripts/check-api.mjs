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
const KEY = process.env.STEAM_API_KEY;
const SPACING_MS = 400;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const APPID = 620; // Portal 2 — stable, always present.

/** @type {{name:string, skip?:string, run:() => Promise<void>}[]} */
const checks = [
  {
    name: "storefront storesearch",
    run: async () => {
      const res = await fetch(`${STORE}/api/storesearch/?term=portal&l=english&cc=US`, {
        headers: { Accept: "application/json" },
      });
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.items)) throw new Error("missing `items` array");
    },
  },
  {
    name: "storefront appdetails",
    run: async () => {
      const res = await fetch(`${STORE}/api/appdetails?appids=${APPID}&cc=US&l=english`, {
        headers: { Accept: "application/json" },
      });
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await res.json();
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
      const body = await res.json();
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
      const body = await res.json();
      if (!Array.isArray(body.achievementpercentages?.achievements))
        throw new Error("missing achievementpercentages.achievements");
    },
  },
  {
    name: "web GetPlayerSummaries (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      // 76561197960287930 = Gabe Newell's public profile (stable).
      const res = await fetch(
        `${API}/ISteamUser/GetPlayerSummaries/v2/?key=${KEY}&steamids=76561197960287930`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.response?.players)) throw new Error("missing response.players");
    },
  },
  {
    // Game-details visibility (owned games, recent playtime, level) isn't
    // guaranteed public even on GABE's own profile — Steam answers 200 with an
    // empty `response: {}` in that case, which is a valid, documented shape
    // (see clients/web.ts isPrivate()), not a broken endpoint. So this accepts
    // EITHER shape and only fails on a genuinely malformed/missing `response`.
    name: "web GetOwnedGames (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(
        `${API}/IPlayerService/GetOwnedGames/v1/?key=${KEY}&steamid=76561197960287930&include_appinfo=true`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await res.json();
      if (typeof body.response !== "object" || body.response === null)
        throw new Error("missing response object");
    },
  },
  {
    // Same privacy caveat as GetOwnedGames above.
    name: "web GetRecentlyPlayedGames (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(
        `${API}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${KEY}&steamid=76561197960287930`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await res.json();
      if (typeof body.response !== "object" || body.response === null)
        throw new Error("missing response object");
    },
  },
  {
    // GetSteamLevel has its own independent failure mode (e.g. private
    // inventory) — same dual-shape acceptance as GetOwnedGames.
    name: "web GetSteamLevel (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(
        `${API}/IPlayerService/GetSteamLevel/v1/?key=${KEY}&steamid=76561197960287930`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await res.json();
      if (typeof body.response !== "object" || body.response === null)
        throw new Error("missing response object");
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
        `${API}/ISteamUser/GetFriendList/v1/?key=${KEY}&steamid=76561197960287930&relationship=friend`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status === 401 || res.status === 403) return; // private friends list — healthy
      if (res.status !== 200)
        throw new Error(`expected 200 (or 401/403 private), got ${res.status}`);
      const body = await res.json();
      if (typeof body.friendslist !== "object" || body.friendslist === null)
        throw new Error("missing friendslist object");
    },
  },
  {
    // Ban status isn't privacy-gated, so this can assert the full shape strictly.
    name: "web GetPlayerBans (key)",
    skip: KEY ? undefined : "STEAM_API_KEY not set",
    run: async () => {
      const res = await fetch(
        `${API}/ISteamUser/GetPlayerBans/v1/?key=${KEY}&steamids=76561197960287930`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await res.json();
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
      const body = await res.json();
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
      const body = await res.json();
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
      const body = await res.json();
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
      if (!Array.isArray(item.tags) || typeof item.tags[0]?.tagid !== "number")
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
      const body = await res.json();
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
      const body = await res.json();
      const items = body.response?.items;
      if (!Array.isArray(items) || !items.length)
        throw new Error("missing response.items — is the test wishlist still public/non-empty?");
      const item = items[0];
      if (typeof item.appid !== "number") throw new Error("missing items[0].appid");
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
      const body = await res.json();
      if (typeof body.response?.metadata?.total_matching_records !== "number")
        throw new Error("missing metadata.total_matching_records");
    },
  },
];

const failures = [];
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
