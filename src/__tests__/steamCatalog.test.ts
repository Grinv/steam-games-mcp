// Integration tests for the keyless-capable Web API tools (get_game_news,
// get_global_achievements, get_current_players, get_items, discover_games,
// get_wishlist, get_followed_games) — mirrors tools/webStore.ts. Split out of a
// single steam.test.ts once it grew past 1600 lines; see steamStorefront.test.ts
// (Storefront tools) and steamPlayer.test.ts (key-gated player tools).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupServer, jsonResponse, htmlResponse, assertToolError } from "./helpers.js";
import { ENV, FOLLOWED, router, routerWithBrokenTagList } from "./steamFixtures.js";

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

  test("get_wishlist tag filter matches the FULL tag set, not the capped display list", async (t) => {
    // Regression: filtering must see every fetched tag. "Deep Cut" has 9 tags with
    // Metroidvania the lowest-weighted (rank 9), so it falls outside the top-8 the
    // card displays — but a tags:["Metroidvania"] filter must still match it.
    const tagNames = {
      1: "Action",
      2: "Adventure",
      3: "Indie",
      4: "Singleplayer",
      5: "Great Soundtrack",
      6: "Difficult",
      7: "Atmospheric",
      8: "Pixel Graphics",
      9: "Metroidvania",
    };
    const detailed = {
      response: {
        items: [
          {
            appid: 5001,
            priority: 1,
            store_item: {
              appid: 5001,
              name: "Deep Cut",
              best_purchase_option: {
                discount_pct: 75,
                formatted_final_price: "$4.99",
                formatted_original_price: "$19.99",
              },
              reviews: { summary_filtered: { percent_positive: 92, review_count: 3000 } },
              // Metroidvania (9) has the lowest weight → past the 8-tag display cap.
              tags: [
                { tagid: 1, weight: 900 },
                { tagid: 2, weight: 850 },
                { tagid: 3, weight: 800 },
                { tagid: 4, weight: 750 },
                { tagid: 5, weight: 700 },
                { tagid: 6, weight: 650 },
                { tagid: 7, weight: 600 },
                { tagid: 8, weight: 550 },
                { tagid: 9, weight: 100 },
              ],
            },
          },
          {
            appid: 5002,
            priority: 2,
            store_item: {
              appid: 5002,
              name: "Not A Metroidvania",
              best_purchase_option: { discount_pct: 80, formatted_final_price: "$1.99" },
              reviews: { summary_filtered: { percent_positive: 95, review_count: 9000 } },
              tags: [
                { tagid: 1, weight: 900 },
                { tagid: 2, weight: 800 },
              ],
            },
          },
        ],
      },
    };
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, (url) => {
      if (url.includes("GetTagList"))
        return jsonResponse({
          response: {
            tags: Object.entries(tagNames).map(([id, name]) => ({ tagid: Number(id), name })),
          },
        });
      if (url.includes("GetWishlistSortedFiltered")) return jsonResponse(detailed);
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: {
        steamid: "76561198028121353",
        tags: ["Metroidvania"],
        min_discount: 50,
        min_review: 80,
      },
    });
    const s = res.structuredContent as {
      matched: number;
      items: { appid: number; tags: string[] }[];
    };
    // Only Deep Cut matches (5002 has 80% off + 95% but isn't a Metroidvania).
    assert.equal(s.matched, 1);
    assert.equal(s.items[0]!.appid, 5001);
    // The card's displayed tags are capped at 8 and therefore DON'T include the
    // low-weighted Metroidvania tag it was matched on — proving the fix.
    assert.equal(s.items[0]!.tags.length, 8);
    assert.ok(!s.items[0]!.tags.includes("Metroidvania"));
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
    assert.equal(a.release_date, "2011-04-19");
    // 999 is absent from store_items → available:false.
    assert.equal(s.items.find((i) => i.appid === 999)!.available, false);
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
    assert.equal(s.deals[0]!.release_date, "2011-04-19");
  });

  test("discover_games recency cutoff excludes older releases", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    // Cutoff in 2020 → Portal 2 (2011) is excluded; nothing else has a date.
    const res = await client.callTool({
      name: "discover_games",
      arguments: { released_after: "2020-01-01" },
    });
    const s = res.structuredContent as { deals: unknown[] };
    assert.equal(s.deals.length, 0);
  });

  test("discover_games released_within_days computes a rolling cutoff (not just released_after)", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    // Portal 2's fixture release date is 2011 — well outside any recent window.
    const recent = await client.callTool({
      name: "discover_games",
      arguments: { released_within_days: 365 },
    });
    assert.equal((recent.structuredContent as { deals: unknown[] }).deals.length, 0);
    // A window wide enough to cover 2011 must still include it.
    const wide = await client.callTool({
      name: "discover_games",
      arguments: { released_within_days: 365 * 20 },
    });
    assert.ok((wide.structuredContent as { deals: { appid: number }[] }).deals.length >= 1);
  });

  test("discover_games: an explicit released_after wins over released_within_days when both are given", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "discover_games",
      // released_after (2020) would exclude Portal 2 (2011); released_within_days
      // (huge window) would include it — the explicit date must win.
      arguments: { released_after: "2020-01-01", released_within_days: 365 * 20 },
    });
    const s = res.structuredContent as { deals: unknown[] };
    assert.equal(s.deals.length, 0);
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

  test("discover_games surfaces resolved tags and filters by tag (client-side, case-insensitive)", async (t) => {
    const { client } = await setupServer(t, { STEAM_API_MIN_INTERVAL_MS: "0" }, router);
    const res = await client.callTool({
      name: "discover_games",
      arguments: { min_discount: 80, tags: ["puzzle"] },
    });
    const s = res.structuredContent as {
      deals: { appid: number; tags: string[] }[];
    };
    // Portal 2 (tagids 10,20 → Puzzle, Co-op) matches "puzzle"; the shovelware
    // (tagid 50 → Shooter) has no Puzzle tag and drops out.
    assert.equal(s.deals.length, 1);
    assert.equal(s.deals[0]!.appid, 620);
    assert.deepEqual(s.deals[0]!.tags, ["Puzzle", "Co-op"]);
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
