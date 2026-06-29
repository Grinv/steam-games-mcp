// Pre-deploy health check for the upstream APIs this server depends on. Each
// check asserts a 200 plus a minimal response shape, so a release can be gated
// against upstream drift. Wired into release.yml before packing.
//
// The Storefront checks need no credentials. The Web API key check runs only
// when STEAM_API_KEY is set (otherwise it is skipped).
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
