// Integration tests for the keyless-capable Web API tools (get_game_news,
// get_global_achievements, get_current_players, get_items, discover_games,
// get_wishlist, get_followed_games) — mirrors tools/webStore.ts. Split out of a
// single steam.test.ts once it grew past 1600 lines; see steamStorefront.test.ts
// (Storefront tools) and steamPlayer.test.ts (key-gated player tools).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupServer, jsonResponse, htmlResponse, assertToolError } from "./helpers.js";
import {
  ENV,
  FOLLOWED,
  TAGLIST,
  router,
  routerWithBrokenTagList,
  routerWithEmptyTagList,
} from "./steamFixtures.js";
import { ITEMS_MAX } from "../tools/common.js";
import { DISCOVER_MAX, WISHLIST_DETAIL_MAX } from "../format/store.js";

const queryFilters = (mock: { calls: { url: string }[] }) =>
  (
    JSON.parse(
      new URL(
        mock.calls.find((c) => c.url.includes("IStoreQueryService/Query"))!.url,
      ).searchParams.get("input_json")!,
    ) as { query: { filters: Record<string, unknown> } }
  ).query.filters;
const startDate = (mock: { calls: { url: string }[] }) =>
  (queryFilters(mock).release_date_filter as { start_date: number }).start_date;

// Steam answers a raw, non-JSON HTTP 400 (not its usual empty-200 response) for
// some malformed/out-of-range steamids — e.g. the SteamID64 base constant
// (accountid 0), which is 17 digits and passes the tool schema but is never a
// real account. Regression coverage for that raw body leaking to the agent.
const ROUTING_400 =
  "<html><body><h1>Bad Request</h1>Missing required routing parameter</body></html>";

test("get_game_news works without a key", async (t) => {
  const { client } = await setupServer(
    t,
    { STEAM_STORE_MIN_INTERVAL_MS: "0", STEAM_API_MIN_INTERVAL_MS: "0" },
    router,
  );
  const res = await client.callTool({ name: "get_game_news", arguments: { appid: 620 } });
  const s = res.structuredContent as { items: { title: string; excerpt: string }[] };
  assert.equal(s.items[0]!.title, "Update");
  assert.equal(s.items[0]!.excerpt, "notes"); // HTML stripped
});

test("get_game_news kind narrows the feed server-side", async (t) => {
  const { client, mock } = await setupServer(t, ENV, router);
  const newsUrl = () => new URL(mock.calls.at(-1)!.url).searchParams;
  await client.callTool({ name: "get_game_news", arguments: { appid: 620 } });
  assert.equal(newsUrl().get("feeds"), null);
  assert.equal(newsUrl().get("tags"), null);
  await client.callTool({ name: "get_game_news", arguments: { appid: 620, kind: "official" } });
  assert.equal(newsUrl().get("feeds"), "steam_community_announcements");
  await client.callTool({ name: "get_game_news", arguments: { appid: 620, kind: "patch_notes" } });
  assert.equal(newsUrl().get("tags"), "patchnotes");
});

test("get_game_news degrades to a clean empty result for a large/unassigned appid, not a misleading credentials error", async (t) => {
  // Regression: Steam answers 403 for GetNewsForApp on a large/unassigned
  // appid (verified live) — never a credentials problem, since this endpoint
  // is keyless by design (docs/architecture.md's "Keyless caveat"). Used to
  // surface the generic "resembles an injection attempt" 403 message, which
  // misled on the single most likely trigger: the appid doesn't exist.
  const { client } = await setupServer(t, ENV, (url) =>
    url.includes("GetNewsForApp") ? jsonResponse({}, { status: 403 }) : router(url),
  );
  const res = await client.callTool({ name: "get_game_news", arguments: { appid: 99999999 } });
  assert.equal(res.isError, undefined);
  assert.deepEqual(res.structuredContent, { items: [] });
});

test("get_global_achievements parses percentages as numbers", async (t) => {
  const { client } = await setupServer(t, ENV, router);
  const res = await client.callTool({
    name: "get_global_achievements",
    arguments: { appid: 620 },
  });
  const s = res.structuredContent as { count: number; achievements: { percent: number }[] };
  assert.equal(s.count, 1);
  assert.equal(s.achievements[0]!.percent, 74.2);
});

test("get_global_achievements degrades to a clean empty result for a schema-less appid (e.g. a DLC/soundtrack), not a misleading credentials error", async (t) => {
  // Regression: Steam answers 403 for GetGlobalAchievementPercentagesForApp on
  // an appid with no achievement schema — verified live. This endpoint is
  // keyless by design (docs/architecture.md), so that 403 can never genuinely
  // be a credentials problem even though a key happens to be attached.
  const { client } = await setupServer(t, ENV, (url) =>
    url.includes("GetGlobalAchievementPercentagesForApp")
      ? jsonResponse({}, { status: 403 })
      : router(url),
  );
  const res = await client.callTool({
    name: "get_global_achievements",
    arguments: { appid: 1206340 },
  });
  assert.equal(res.isError, undefined);
  const s = res.structuredContent as { count: number; returned: number; achievements: unknown[] };
  assert.equal(s.count, 0);
  assert.equal(s.returned, 0);
  assert.deepEqual(s.achievements, []);
});

test("get_global_achievements never caches that degraded empty result", async (t) => {
  // Regression: the degrade-to-empty catch used to sit INSIDE wrapStaleOnError
  // and RETURN the empty result, so TtlCache#dedupe set() it — a single 403
  // (Steam's edge answers that under load, not only for a schema-less appid)
  // then served "this game has no achievements" for the whole TTL, and the
  // tool's own description tells the model to read it exactly that way.
  // A real list on the retry is what proves the empty one was never cached.
  let calls = 0;
  const { client } = await setupServer(t, ENV, (url) => {
    if (!url.includes("GetGlobalAchievementPercentagesForApp")) return router(url);
    calls++;
    if (calls === 1) return jsonResponse({}, { status: 403 });
    return router(url);
  });
  const degraded = await client.callTool({
    name: "get_global_achievements",
    arguments: { appid: 620 },
  });
  assert.equal((degraded.structuredContent as { count: number }).count, 0);

  const retried = await client.callTool({
    name: "get_global_achievements",
    arguments: { appid: 620 },
  });
  assert.equal(retried.isError, undefined);
  const s = retried.structuredContent as { count: number; achievements: { percent: number }[] };
  assert.equal(s.count, 1, "the retry must reach Steam, not a cached empty list");
  assert.equal(s.achievements[0]!.percent, 74.2);
  assert.equal(calls, 2);
});

test("get_global_achievements serves a stale list rather than the degraded empty one", async (t) => {
  // The other half of moving the catch outside wrapStaleOnError: with a good
  // entry already cached, a later 403 must fall back to it. Previously the
  // empty result was set() straight over that entry, destroying the very
  // fallback wrapStaleOnError exists to provide.
  let calls = 0;
  const { client } = await setupServer(t, { ...ENV, CACHE_TTL_MS: "1" }, (url) => {
    if (!url.includes("GetGlobalAchievementPercentagesForApp")) return router(url);
    calls++;
    if (calls === 1) return router(url);
    return jsonResponse({}, { status: 403 });
  });
  const first = await client.callTool({
    name: "get_global_achievements",
    arguments: { appid: 620 },
  });
  assert.equal((first.structuredContent as { count: number }).count, 1);

  await new Promise((r) => setTimeout(r, 5)); // let the 1 ms entry go stale
  const second = await client.callTool({
    name: "get_global_achievements",
    arguments: { appid: 620 },
  });
  assert.equal(second.isError, undefined);
  assert.equal(
    (second.structuredContent as { count: number }).count,
    1,
    "a stale-but-real list beats degrading to empty",
  );
  assert.equal(calls, 2);
});

test("get_current_players works without a key and returns the count", async (t) => {
  const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
  const res = await client.callTool({ name: "get_current_players", arguments: { appid: 730 } });
  const s = res.structuredContent as { appid: number; player_count: number };
  assert.equal(s.appid, 730);
  assert.equal(s.player_count, 12345);
});

test("get_current_players errors on an unknown appid instead of reporting a silent null count", async (t) => {
  // Regression: Steam answers HTTP 404 with `{result:42}` (no player_count) for
  // an invalid/unknown appid — verified live — which used to either surface as
  // the generic HTTP-layer "not found" (losing the appid) or, if ever answered
  // as a 200, pass through as player_count:null indistinguishable from a
  // genuine (nonexistent) zero.
  const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, (url) =>
    url.includes("GetNumberOfCurrentPlayers")
      ? jsonResponse({ response: { result: 42 } }, { status: 404 })
      : jsonResponse({}),
  );
  const res = await client.callTool({
    name: "get_current_players",
    arguments: { appid: 999999999 },
  });
  assertToolError(res, /no steam app with id 999999999/i);
});

test("get_current_players errors on a 200 response with a non-1 result too", async (t) => {
  const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, (url) =>
    url.includes("GetNumberOfCurrentPlayers")
      ? jsonResponse({ response: { result: 42 } })
      : jsonResponse({}),
  );
  const res = await client.callTool({
    name: "get_current_players",
    arguments: { appid: 999999999 },
  });
  assertToolError(res, /no steam app with id 999999999/i);
});

test("get_current_players: a 403 with a key configured is not blamed on credentials (endpoint is keyless by design)", async (t) => {
  const { client } = await setupServer(t, ENV, (url) =>
    url.includes("GetNumberOfCurrentPlayers") ? jsonResponse({}, { status: 403 }) : router(url),
  );
  const res = await client.callTool({ name: "get_current_players", arguments: { appid: 730 } });
  assertToolError(res, /sends no credentials/i);
});

describe("get_wishlist", () => {
  test("get_wishlist sorts by priority (no key) and reports private as not-found", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353" },
    });
    const s = res.structuredContent as {
      found: boolean;
      total: number;
      items: { appid: number }[];
    };
    assert.equal(s.found, true);
    assert.equal(s.total, 2);
    assert.equal(s.items[0]!.appid, 620); // priority 1 sorts first
  });

  test("get_wishlist (light): a 403 with a key configured is not blamed on credentials (endpoint is keyless by design)", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetWishlist/v1") ? jsonResponse({}, { status: 403 }) : router(url),
    );
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353" },
    });
    assertToolError(res, /sends no credentials/i);
  });

  test("get_wishlist include_details returns full store cards (name, price, tags) in one call", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353", include_details: true },
    });
    const s = res.structuredContent as {
      found: boolean;
      total: number;
      items: { appid: number; name: string; discount_pct: number; tags: string[] }[];
    };
    assert.equal(s.found, true);
    assert.equal(s.total, 2);
    // Both items returned, priority order (620 priority 1 first), with resolved cards.
    assert.equal(s.items[0]!.appid, 620);
    assert.equal(s.items[0]!.name, "Portal 2");
    assert.equal(s.items[0]!.discount_pct, 80);
    assert.deepEqual(s.items[0]!.tags, ["Puzzle"]); // tagid 10 → Puzzle
  });

  test(`get_wishlist include_details caps its cards at ${WISHLIST_DETAIL_MAX}, reporting the true match count`, async (t) => {
    // A store card is ~550-580 B, so an unfiltered detailed wishlist of 60
    // measured ~35 KB, at the edge of what MCP clients accept.
    const items = Array.from({ length: 80 }, (_, i) => ({
      appid: 2000 + i,
      priority: i + 1,
      store_item: {
        appid: 2000 + i,
        name: `Game ${i}`,
        visible: true,
        best_purchase_option: { packageid: 1, formatted_final_price: "$9.99" },
      },
    }));
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, (url) =>
      url.includes("GetWishlistSortedFiltered")
        ? jsonResponse({ response: { items } })
        : router(url),
    );
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353", include_details: true },
    });
    const s = res.structuredContent as { matched: number; returned: number; items: unknown[] };
    assert.equal(s.matched, 80);
    assert.equal(s.returned, WISHLIST_DETAIL_MAX);
    assert.equal(s.items.length, WISHLIST_DETAIL_MAX);
  });

  test("get_wishlist include_details: a malformed/out-of-range steamid reports found:false, not a raw HTML error", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, (url) =>
      url.includes("GetWishlistSortedFiltered") ? htmlResponse(ROUTING_400) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561197960265728", include_details: true }, // accountid 0
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /private/i);
  });

  test("get_wishlist on_sale_only keeps only discounted items, ranked by discount", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353", on_sale_only: true },
    });
    const s = res.structuredContent as {
      found: boolean;
      matched: number;
      items: { appid: number; discount_pct: number }[];
    };
    // 660 (0% off) drops out; only 620 (80%) remains.
    assert.equal(s.matched, 1);
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0]!.appid, 620);
    assert.equal(s.items[0]!.discount_pct, 80);
  });

  test("get_wishlist filters detailed items by tag + min_discount over the whole wishlist", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    // "Puzzle games on my wishlist with a good discount" — 620 (Puzzle, 80% off)
    // matches; 660 (Action Roguelike, 0% off) fails both the tag and the discount.
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353", tags: ["puzzle"], min_discount: 50 },
    });
    const s = res.structuredContent as {
      total: number;
      matched: number;
      items: { appid: number; tags: string[]; discount_pct: number }[];
    };
    assert.equal(s.total, 2); // whole wishlist scanned
    assert.equal(s.matched, 1); // one match before the cap
    assert.equal(s.items[0]!.appid, 620);
    assert.deepEqual(s.items[0]!.tags, ["Puzzle"]);
  });

  test("get_wishlist filters by steam_os (Proton) compatibility, distinct from native platform", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353", steam_os: "playable" },
    });
    const s = res.structuredContent as {
      matched: number;
      items: { appid: number; steam_os: string; platforms: string[] }[];
    };
    // 620 is SteamOS-Playable (cat 2); 660 (cat 1, unsupported) drops out.
    assert.equal(s.matched, 1);
    assert.equal(s.items[0]!.appid, 620);
    assert.equal(s.items[0]!.steam_os, "playable");
    // steam_os is a Proton rating — the game has no native linux build here.
    assert.ok(!s.items[0]!.platforms.includes("linux"));
  });

  test("get_wishlist filters by steam_machine compatibility, distinct from steam_os", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353", steam_machine: "playable" },
    });
    const s = res.structuredContent as {
      matched: number;
      items: { appid: number; steam_machine: string }[];
    };
    // 620 is Steam-Machine-Playable (cat 2); 660 (cat 1, unsupported) drops out.
    assert.equal(s.matched, 1);
    assert.equal(s.items[0]!.appid, 620);
    assert.equal(s.items[0]!.steam_machine, "playable");
  });

  test("get_wishlist: a refused filtered call on a non-empty wishlist is an error, not 'nothing matched'", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) =>
      url.includes("GetWishlistSortedFiltered")
        ? jsonResponse({ error: "bad" }, { status: 400 })
        : router(url),
    );
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561197960287930", min_review: 80 },
    });
    assertToolError(res, /refused the filtered wishlist/i);
  });

  test("get_wishlist sends tags, Steam Deck, platform and a discount floor to Steam", async (t) => {
    const { client, mock } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    await client.callTool({
      name: "get_wishlist",
      arguments: {
        steamid: "76561197960287930",
        tags: ["deckbuilding", "Puzzle"],
        steam_deck: "playable",
        platform: "mac",
        on_sale_only: true,
      },
    });
    const call = mock.calls.find((c) => c.url.includes("GetWishlistSortedFiltered"))!;
    const input = JSON.parse(new URL(call.url).searchParams.get("input_json")!) as {
      filters: Record<string, unknown>;
      page_size: number;
    };
    assert.deepEqual(input.filters, {
      tagids_must_match: [40, 10],
      steam_deck_filters: { include_verified: true, include_playable: true },
      macos_only: true,
      min_discount_percent: 1,
    });
    // on_sale_only is re-checked here (own-package discount), so every match
    // needs a card, not just the 50-item display page.
    assert.ok(input.page_size > 50);
  });

  test("get_wishlist returns found:false when empty/private", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, (url) =>
      url.includes("GetWishlist") ? jsonResponse({ response: {} }) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /private/);
  });

  test("get_wishlist: a malformed/out-of-range steamid reports found:false, not a raw HTML error", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, (url) =>
      url.includes("GetWishlist") ? htmlResponse(ROUTING_400) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561197960265728" }, // accountid 0
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /private/i);
  });

  test("get_wishlist: tags filter errors clearly when GetTagList is unavailable (no silent empty result)", async (t) => {
    const { client } = await setupServer(
      t,
      { STEAM_API_MIN_INTERVAL_MS: "0", HTTP_RETRIES: "0" },
      routerWithBrokenTagList,
    );
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353", tags: ["Metroidvania"] },
    });
    assertToolError(res, /tag dictionary/i);
  });

  test("get_wishlist: an empty tag dictionary fails loudly instead of matching nothing", async (t) => {
    // GetTagList answers an unrecognized language with 200 + {} rather than an
    // error, so the dictionary came back empty-but-not-null and slipped past the
    // null guard — every tag filter then rejected every item, which reads as an
    // honest "no games matched" to the agent.
    const { client } = await setupServer(
      t,
      { STEAM_API_MIN_INTERVAL_MS: "0", HTTP_RETRIES: "0" },
      routerWithEmptyTagList,
    );
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353", tags: ["Metroidvania"], language: "ru" },
    });
    assertToolError(res, /tag dictionary/i);
  });

  test("discover_games: an empty tag dictionary fails loudly instead of matching nothing", async (t) => {
    const { client } = await setupServer(
      t,
      { STEAM_API_MIN_INTERVAL_MS: "0", HTTP_RETRIES: "0" },
      routerWithEmptyTagList,
    );
    const res = await client.callTool({
      name: "discover_games",
      arguments: { tags: ["Puzzle"], language: "ru" },
    });
    assertToolError(res, /tag dictionary/i);
  });

  test("get_wishlist: country/language alone switch to detailed mode (not silently ignored)", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353", country: "DE" },
    });
    const s = res.structuredContent as { items: { appid: number; name?: string }[] };
    // The light path has no `name` field; getting one back proves country
    // triggered the detailed (store-card) path instead of being dropped.
    assert.equal(s.items[0]!.name, "Portal 2");
  });

  test("get_wishlist: min_review alone also switches to detailed mode", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353", min_review: 0 },
    });
    const s = res.structuredContent as { items: { appid: number; name?: string }[] };
    assert.equal(s.items[0]!.name, "Portal 2");
  });

  test("get_wishlist: explicit on_sale_only:false does NOT force detailed mode (light list stays light)", async (t) => {
    // Regression per clients/web.ts#getWishlist's own comment: onSaleOnly is
    // checked by truthiness so `false` means "don't require a discount", not
    // an opt-in to the detailed card view — distinct from every other filter
    // field, which triggers detailed just by being present (even at 0/undefined-ish).
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561198028121353", on_sale_only: false },
    });
    const s = res.structuredContent as { items: { appid: number; name?: string }[] };
    assert.equal(s.items[0]!.name, undefined);
  });
});

describe("bundle prices", () => {
  // Steam's "best purchase option" is whatever it considers best value, often a
  // bundle of this app AND another game — bundle 67187 covers appids 262060 and
  // 2186680, so its $48.36 prices two games and undercuts Rogue Trader's own
  // $49.99. A game's price must be what the game costs on its own.
  const BUNDLE_BEST = {
    bundleid: 67187,
    formatted_final_price: "$48.36",
    formatted_original_price: "$67.48",
    discount_pct: 28,
  };
  const OWN = { packageid: 782856, formatted_final_price: "$49.99", discount_pct: 0 };
  const card = (purchase_options: unknown[]) => ({
    response: {
      store_items: [
        {
          appid: 2186680,
          name: "Warhammer 40,000: Rogue Trader",
          best_purchase_option: BUNDLE_BEST,
          purchase_options,
          reviews: { summary_filtered: { percent_positive: 90, review_count: 100 } },
        },
      ],
    },
  });
  const serve = (body: unknown) => (url: string) =>
    jsonResponse(url.includes("IStoreBrowseService/GetItems") ? body : TAGLIST);

  test("get_items reports the game's own package, not the bundle containing it", async (t) => {
    const { client } = await setupServer(
      t,
      { STEAM_API_MIN_INTERVAL_MS: "0" },
      serve(card([BUNDLE_BEST, OWN])),
    );
    const res = await client.callTool({ name: "get_items", arguments: { appids: [2186680] } });
    const s = res.structuredContent as {
      items: { price: { final: string; discount_pct: number } }[];
    };
    assert.equal(s.items[0]!.price.final, "$49.99");
    assert.equal(s.items[0]!.price.discount_pct, 0);
  });

  test("every card request asks for all purchase options, so no follow-up is needed", async (t) => {
    // Asked up front rather than fetched separately for the ~1% of apps that
    // need it: measured, the extra round-trip costs as much as the bigger
    // payload, and this way there's no second request to fail.
    const { client, mock } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    await client.callTool({ name: "get_items", arguments: { appids: [620] } });
    const calls = mock.calls.filter((c) => c.url.includes("IStoreBrowseService/GetItems"));
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /include_all_purchase_options/);
  });

  test("a bundle-only app keeps the bundle price rather than reporting none", async (t) => {
    // No own package exists, and a null price would read as "not sold here".
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, serve(card([])));
    const res = await client.callTool({ name: "get_items", arguments: { appids: [2186680] } });
    const s = res.structuredContent as { items: { price: { final: string } }[] };
    assert.equal(s.items[0]!.price.final, "$48.36");
  });

  test("a free-to-play app isn't priced at one of its paid add-on packages", async (t) => {
    // Live shape (Counter-Strike 2): is_free, no best_purchase_option, and the
    // Prime Status Upgrade as a packageid-bearing purchase option.
    const f2p = {
      response: {
        store_items: [
          {
            appid: 730,
            name: "Counter-Strike 2",
            is_free: true,
            purchase_options: [
              { packageid: 54029, formatted_final_price: "$14.99", discount_pct: 0 },
            ],
          },
        ],
      },
    };
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, serve(f2p));
    const res = await client.callTool({ name: "get_items", arguments: { appids: [730] } });
    const s = res.structuredContent as { items: { is_free: boolean; price: unknown }[] };
    assert.equal(s.items[0]!.is_free, true);
    assert.deepEqual(s.items[0]!.price, { is_free: true });
  });

  test("discover_games filters on the game's own discount, not the bundle's", async (t) => {
    // The bundle is 28% off while the game itself isn't discounted at all, so a
    // min_discount of 20 must not surface it as a deal.
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, (url) =>
      jsonResponse(url.includes("IStoreQueryService/Query") ? card([BUNDLE_BEST, OWN]) : TAGLIST),
    );
    const res = await client.callTool({
      name: "discover_games",
      arguments: { min_discount: 20, count: 10 },
    });
    const s = res.structuredContent as { returned: number };
    assert.equal(s.returned, 0);
  });
});

describe("get_items", () => {
  test("get_items returns batch store cards (price, review %, release) keyless", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({ name: "get_items", arguments: { appids: [620, 999] } });
    const s = res.structuredContent as {
      count: number;
      items: {
        appid: number;
        available?: boolean;
        store_url?: string;
        price?: { discount_pct: number; discount_end?: string };
        review_percent?: number;
        steam_deck?: string;
        steam_os?: string;
        steam_machine?: string;
        steam_frame?: string;
        vr_support?: string;
        tags?: string[];
        release_date?: string;
      }[];
    };
    assert.equal(s.count, 2);
    const a = s.items.find((i) => i.appid === 620)!;
    assert.equal(a.store_url, "https://store.steampowered.com/app/620");
    assert.equal(a.price!.discount_pct, 80);
    assert.equal(a.price!.discount_end, "2026-07-09T17:00:00Z"); // from active_discounts end date
    assert.equal(a.review_percent, 98);
    assert.equal(a.steam_deck, "verified"); // steam_deck_compat_category 3 → verified
    assert.equal(a.steam_os, "playable"); // steam_os_compat_category 2 → playable
    assert.equal(a.steam_machine, "unsupported"); // steam_machine_compat_category 1 → unsupported
    assert.equal(a.steam_frame, "unknown"); // steam_frame_compat_category 0 → unknown
    assert.equal(a.vr_support, "none"); // fixture carries no vr_support key
    // tagids 10,20 resolved via GetTagList, ordered by weight (900 > 500).
    assert.deepEqual(a.tags, ["Puzzle", "Co-op"]);
    assert.equal(a.release_date, "2011-04-18");
    // 999 is absent from store_items → available:false.
    assert.equal(s.items.find((i) => i.appid === 999)!.available, false);
  });

  test("get_items: a 403 with a key configured is not blamed on credentials (endpoint is keyless by design)", async (t) => {
    // Regression: IStoreBrowseService/GetItems is keyless-capable, same as the
    // SteamWebClient methods above — but backed by StoreServiceClient
    // (clients/storeService.ts), a separate code path that initially missed
    // the hasCredentials override applied to the others.
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("IStoreBrowseService/GetItems")
        ? jsonResponse({}, { status: 403 })
        : router(url),
    );
    const res = await client.callTool({ name: "get_items", arguments: { appids: [620] } });
    assertToolError(res, /sends no credentials/i);
  });

  test("get_items: still succeeds when GetTagList is unavailable (tags are display-only there)", async (t) => {
    const { client } = await setupServer(
      t,
      { STEAM_API_MIN_INTERVAL_MS: "0", HTTP_RETRIES: "0" },
      routerWithBrokenTagList,
    );
    const res = await client.callTool({ name: "get_items", arguments: { appids: [620] } });
    const s = res.structuredContent as { items: { appid: number; tags: string[] }[] };
    assert.equal(s.items[0]!.tags.length, 0);
  });

  test("get_items: an empty tag dictionary still degrades to empty tags (display-only, never filtered)", async (t) => {
    // The sibling of the broken-GetTagList case above: get_items never filters
    // by tags, so an unavailable dictionary must stay a graceful degrade here
    // even though it's now a loud error on the filtering tools.
    const { client } = await setupServer(
      t,
      { STEAM_API_MIN_INTERVAL_MS: "0", HTTP_RETRIES: "0" },
      routerWithEmptyTagList,
    );
    const res = await client.callTool({ name: "get_items", arguments: { appids: [620] } });
    const s = res.structuredContent as { items: { appid: number; tags: string[] }[] };
    assert.notEqual(res.isError, true);
    assert.equal(s.items[0]!.tags.length, 0);
  });

  test(`get_items rejects appids outside the 1-${ITEMS_MAX} bound before calling the upstream`, async (t) => {
    const { client, mock } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const tooMany = await client.callTool({
      name: "get_items",
      arguments: { appids: Array.from({ length: ITEMS_MAX + 1 }, (_, i) => i + 1) },
    });
    assert.equal(tooMany.isError, true);
    const empty = await client.callTool({ name: "get_items", arguments: { appids: [] } });
    assert.equal(empty.isError, true);
    assert.equal(mock.calls.filter((c) => c.url.includes("IStoreBrowseService")).length, 0);
  });
});

describe("get_followed_games", () => {
  test("get_followed_games returns followed appids keyless, with the true total", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "get_followed_games",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as {
      found: boolean;
      total: number;
      returned: number;
      games: { appid: number; store_url: string }[];
    };
    assert.equal(s.found, true);
    assert.equal(s.total, 2);
    assert.equal(s.returned, 2);
    assert.deepEqual(
      s.games.map((g) => g.appid),
      [620, 400],
    );
    assert.equal(s.games[0]!.store_url, "https://store.steampowered.com/app/620");
  });

  test("get_followed_games reports found:false for an empty/private follow list", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, (url) =>
      url.includes("GetGamesFollowed") ? jsonResponse({ response: {} }) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_followed_games",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; total: number };
    assert.equal(s.found, false);
    assert.equal(s.total, 0);
  });

  test("get_followed_games: a malformed/out-of-range steamid reports found:false, not a raw HTML error", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, (url) =>
      url.includes("GetGamesFollowed") ? htmlResponse(ROUTING_400) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_followed_games",
      arguments: { steamid: "76561197960265728" }, // accountid 0
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; total: number };
    assert.equal(s.found, false);
    assert.equal(s.total, 0);
  });

  test("get_followed_games: a 403 with a key configured is not blamed on credentials (endpoint is keyless by design)", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetGamesFollowed") ? jsonResponse({}, { status: 403 }) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_followed_games",
      arguments: { steamid: "76561197960287930" },
    });
    assertToolError(res, /sends no credentials/i);
  });

  test("get_followed_games still succeeds when GetGamesFollowedCount fails (falls back to appids.length)", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, (url) => {
      if (url.includes("GetGamesFollowedCount")) return jsonResponse({}, { status: 500 });
      if (url.includes("GetGamesFollowed")) return jsonResponse(FOLLOWED);
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_followed_games",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; total: number; returned: number };
    assert.equal(res.isError, undefined);
    assert.equal(s.found, true);
    assert.equal(s.total, 2); // count endpoint failed → falls back to appids.length
    assert.equal(s.returned, 2);
  });
});

describe("discover_games", () => {
  test("discover_games filters by min discount + review quality, skips hidden, keyless", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "discover_games",
      arguments: { min_discount: 80, min_review: 90, min_reviews: 100 },
    });
    const s = res.structuredContent as {
      total_matching: number;
      deals: {
        appid: number;
        discount_pct: number;
        review_percent: number;
        discount_end: string;
      }[];
    };
    assert.equal(s.total_matching, 14132);
    // Only Portal 2 passes: shovelware (40%/5 reviews) and the hidden item drop out.
    assert.equal(s.deals.length, 1);
    assert.equal(s.deals[0]!.appid, 620);
    assert.equal(s.deals[0]!.discount_pct, 80);
    assert.equal(s.deals[0]!.review_percent, 98);
    assert.equal(s.deals[0]!.discount_end, "2026-07-09T17:00:00Z"); // active_discounts end date
  });

  test("discover_games filters by recency + Deck + rating (no discount required)", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    // Portal 2 (released 2011-04-19, deck verified, 98%) passes; the unsupported
    // shovelware and the hidden item drop out.
    const res = await client.callTool({
      name: "discover_games",
      arguments: { released_after: "2011-01-01", steam_deck: "verified", min_review: 90 },
    });
    const s = res.structuredContent as {
      deals: { appid: number; steam_deck: string; release_date: string }[];
    };
    assert.equal(s.deals.length, 1);
    assert.equal(s.deals[0]!.appid, 620);
    assert.equal(s.deals[0]!.steam_deck, "verified");
    assert.equal(s.deals[0]!.release_date, "2011-04-18");
  });

  test("discover_games sends released_after to Steam as the store-day (Pacific) cutoff", async (t) => {
    const { client, mock } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    await client.callTool({ name: "discover_games", arguments: { released_after: "2020-01-01" } });
    // 2020-01-01 00:00 PST = 08:00 UTC.
    assert.equal(startDate(mock), Date.UTC(2020, 0, 1, 8) / 1000);
    assert.equal(queryFilters(mock).released_only, true);
  });

  test("discover_games released_within_days sends a rolling cutoff (not just released_after)", async (t) => {
    const { client, mock } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    await client.callTool({ name: "discover_games", arguments: { released_within_days: 365 } });
    const expected = Math.floor(Date.now() / 1000) - 365 * 86400;
    assert.ok(Math.abs(startDate(mock) - expected) < 60);
  });

  test(`discover_games caps its result list at ${DISCOVER_MAX}, reporting the true match count`, async (t) => {
    // `count` scans up to 200 catalog entries and, with loose filters, nearly all
    // survive — ~195 store cards is ~104 KB, which an MCP client rejects outright
    // for exceeding its per-result token limit, so the caller gets nothing. Same
    // failure that halved get_items'/get_prices' caps; this was the one card list
    // still uncapped, and its own description says to raise `count`.
    const many = Array.from({ length: 195 }, (_, i) => ({
      appid: 1000 + i,
      name: `Game ${i}`,
      visible: true,
      best_purchase_option: {
        // Ascending discount, so the cap must keep the BEST deals (it sorts desc).
        discount_pct: i,
        formatted_final_price: "$1.99",
        formatted_original_price: "$9.99",
      },
      reviews: { summary_filtered: { percent_positive: 90, review_count: 100 } },
      platforms: { windows: true },
    }));
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, (url) =>
      url.includes("IStoreQueryService/Query")
        ? jsonResponse({
            response: { metadata: { total_matching_records: 9999 }, store_items: many },
          })
        : router(url),
    );
    const res = await client.callTool({ name: "discover_games", arguments: { count: 200 } });
    const s = res.structuredContent as {
      matched: number;
      returned: number;
      deals: { discount_pct: number }[];
    };
    assert.equal(s.matched, 195);
    assert.equal(s.returned, DISCOVER_MAX);
    assert.equal(s.deals.length, DISCOVER_MAX);
    assert.equal(s.deals[0]!.discount_pct, 194); // best discount survives the cap
  });

  test("discover_games rejects a well-formed date that isn't a real calendar date", async (t) => {
    const { client, mock } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    // Both pass the YYYY-MM-DD regex. "2026-13-45" made Date.parse return NaN,
    // and every `< NaN` comparison is false, so the cutoff matched EVERYTHING
    // while releasedOnly was still sent upstream — the response looked filtered.
    // "2026-02-31" silently rolled over to 2026-03-03, moving the cutoff.
    for (const released_after of ["2026-13-45", "2026-02-31", "0000-00-00"]) {
      const res = await client.callTool({ name: "discover_games", arguments: { released_after } });
      assert.equal(res.isError, true, released_after);
    }
    // Rejected by the schema, so nothing reached the catalog.
    assert.equal(mock.calls.filter((c) => c.url.includes("IStoreQueryService")).length, 0);

    const ok = await client.callTool({
      name: "discover_games",
      arguments: { released_after: "2011-01-01" },
    });
    assert.notEqual(ok.isError, true);
  });

  test("discover_games: an explicit released_after wins over released_within_days when both are given", async (t) => {
    const { client, mock } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    await client.callTool({
      name: "discover_games",
      arguments: { released_after: "2020-01-01", released_within_days: 365 * 20 },
    });
    assert.equal(startDate(mock), Date.UTC(2020, 0, 1, 8) / 1000);
  });

  test("discover_games filters by Steam Deck compatibility and tags each result", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "discover_games",
      arguments: { min_discount: 80, steam_deck: "verified" },
    });
    const s = res.structuredContent as {
      deals: { appid: number; steam_deck: string }[];
    };
    // Only Portal 2 is Deck-Verified (cat 3); the Unsupported shovelware (cat 1) drops out.
    assert.equal(s.deals.length, 1);
    assert.equal(s.deals[0]!.appid, 620);
    assert.equal(s.deals[0]!.steam_deck, "verified");
  });

  test("discover_games filters by SteamOS compatibility and tags each result", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "discover_games",
      arguments: { min_discount: 80, steam_os: "playable" },
    });
    const s = res.structuredContent as {
      deals: { appid: number; steam_os: string; steam_frame: string }[];
    };
    // Portal 2 is SteamOS-Playable (cat 2 ≥ 2); the shovelware (cat 1) drops out.
    assert.equal(s.deals.length, 1);
    assert.equal(s.deals[0]!.appid, 620);
    assert.equal(s.deals[0]!.steam_os, "playable");
    assert.equal(s.deals[0]!.steam_frame, "unknown"); // frame cat 0 → unknown
  });

  test("discover_games filters by Steam Machine compatibility, distinct from steam_os", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "discover_games",
      arguments: { min_discount: 80, steam_machine: "playable" },
    });
    const s = res.structuredContent as {
      deals: { appid: number; steam_machine: string }[];
    };
    // Portal 2 is Steam-Machine-Playable (cat 2 ≥ 2); the shovelware (cat 1) drops out.
    assert.equal(s.deals.length, 1);
    assert.equal(s.deals[0]!.appid, 620);
    assert.equal(s.deals[0]!.steam_machine, "playable");
  });

  test("discover_games filters by native platform and surfaces the platforms list", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "discover_games",
      arguments: { min_discount: 80, platform: "linux" },
    });
    const s = res.structuredContent as {
      deals: { appid: number; platforms: string[] }[];
    };
    // Portal 2 has a native Linux build; the windows-only shovelware drops out.
    assert.equal(s.deals.length, 1);
    assert.equal(s.deals[0]!.appid, 620);
    assert.deepEqual(s.deals[0]!.platforms, ["windows", "linux"]);
  });

  test("discover_games resolves tag names to ids for Steam (case-insensitive) and shows tag names", async (t) => {
    const { client, mock } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "discover_games",
      arguments: { min_discount: 80, tags: ["puzzle"] },
    });
    assert.deepEqual(queryFilters(mock).tagids_must_match, [{ tagids: [10] }]);
    const s = res.structuredContent as { deals: { appid: number; tags: string[] }[] };
    // Portal 2 (tagids 10,20 → Puzzle, Co-op).
    assert.deepEqual(s.deals.find((d) => d.appid === 620)!.tags, ["Puzzle", "Co-op"]);
  });

  test("discover_games sends tags, compat, review floor, release date and games-only to Steam", async (t) => {
    // Server-side, so the page holds real matches from the whole catalog
    // instead of whatever matches sit inside the top-`count` popularity window.
    const { client, mock } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    await client.callTool({
      name: "discover_games",
      arguments: {
        tags: ["Puzzle", "co-op"],
        steam_deck: "playable",
        steam_machine: "verified",
        min_review: 85,
        released_after: "2026-03-01",
      },
    });
    const call = mock.calls.find((c) => c.url.includes("IStoreQueryService/Query"))!;
    const input = JSON.parse(new URL(call.url).searchParams.get("input_json")!) as {
      query: { filters: Record<string, unknown> };
    };
    const f = input.query.filters;
    assert.deepEqual(f.type_filters, { include_games: true });
    assert.deepEqual(f.tagids_must_match, [{ tagids: [10] }, { tagids: [20] }]);
    // One compatibility_filter only: the first set dimension (Deck); the
    // Machine requirement is left to the client-side re-check.
    assert.deepEqual(f.compatibility_filter, { device: 1, categories: [2, 3] });
    assert.deepEqual(f.review_score_filter, { min_score: 7 });
    // At exactly a bucket edge the floor drops one bucket: a 79.6% game reads
    // 80 but sits in Mostly Positive (6), and must reach the exact re-check.
    mock.calls.length = 0;
    await client.callTool({ name: "discover_games", arguments: { min_review: 80 } });
    assert.deepEqual(queryFilters(mock).review_score_filter, { min_score: 6 });
    assert.equal((f.release_date_filter as { release_date_type: number }).release_date_type, 1);
    assert.equal(f.released_only, true);
  });

  test("discover_games: an unknown tag matches nothing without querying the catalog", async (t) => {
    const { client, mock } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "discover_games",
      arguments: { tags: ["Puzzle", "Not A Real Tag"] },
    });
    assert.equal(res.isError, undefined);
    assert.equal((res.structuredContent as { matched: number }).matched, 0);
    assert.ok(!mock.calls.some((c) => c.url.includes("IStoreQueryService/Query")));
  });

  test("discover_games: tags filter errors clearly when GetTagList is unavailable (no silent empty result)", async (t) => {
    const { client } = await setupServer(
      t,
      { STEAM_API_MIN_INTERVAL_MS: "0", HTTP_RETRIES: "0" },
      routerWithBrokenTagList,
    );
    const res = await client.callTool({
      name: "discover_games",
      arguments: { min_discount: 80, tags: ["puzzle"] },
    });
    assertToolError(res, /tag dictionary/i);
  });

  test("discover_games: still succeeds without a tags filter even when GetTagList is unavailable", async (t) => {
    const { client } = await setupServer(
      t,
      { STEAM_API_MIN_INTERVAL_MS: "0", HTTP_RETRIES: "0" },
      routerWithBrokenTagList,
    );
    const res = await client.callTool({
      name: "discover_games",
      arguments: { min_discount: 80 },
    });
    const s = res.structuredContent as { deals: { appid: number; tags: string[] }[] };
    // Portal 2 (80% off) and the shovelware (90% off) both pass min_discount:80
    // with no tags filter active — no error, just empty `tags` on every card.
    assert.equal(s.deals.length, 2);
    assert.ok(s.deals.every((d) => d.tags.length === 0));
  });
});
