// Integration tests for the keyless Storefront tools (search_games, get_game,
// get_game_reviews, get_specials, get_review_histogram) — mirrors
// tools/storefront.ts. Split out of a single steam.test.ts once it grew past
// 1600 lines; see steamCatalog.test.ts (keyless Web API store tools) and
// steamPlayer.test.ts (key-gated player tools) for the rest.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  setupServer,
  jsonResponse,
  assertToolError,
  mockFetch,
  installFetch,
  silentLogger,
} from "./helpers.js";
import { APP, ENV, router } from "./steamFixtures.js";
import { PRICES_MAX } from "../tools/common.js";
import { StorefrontClient } from "../clients/storefront.js";
import { loadConfig } from "../config.js";
import { PRICE_LOOKUP_CHUNK } from "../clients/storeService.js";

test("the server advertises store and player tools", async (t) => {
  const { client } = await setupServer(t, ENV, router);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    "search_games",
    "get_game",
    "get_specials",
    "get_charts",
    "get_player_summary",
    "resolve_vanity_url",
  ]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
});

describe("search_games", () => {
  const input = (mock: { calls: { url: string }[] }) =>
    JSON.parse(
      new URL(mock.calls.find((c) => c.url.includes("SearchSuggestions"))!.url).searchParams.get(
        "input_json",
      )!,
    ) as {
      search_term: string;
      max_results: number;
      context: { country_code: string; language: string };
      filters?: unknown;
    };

  test("search_games returns appids with price, metascore, type and Steam's full total", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    const res = await client.callTool({ name: "search_games", arguments: { term: "portal" } });
    const s = res.structuredContent as { total: number; returned: number; results: unknown[] };
    assert.equal(s.total, 204);
    assert.equal(s.returned, 1);
    assert.deepEqual(s.results[0], {
      appid: 620,
      name: "Portal 2",
      type: "game",
      price: { final: "$9.99", initial: "$9.99", discount_percent: 0 },
      metascore: "95",
      platforms: ["windows", "linux"],
      store_url: "https://store.steampowered.com/app/620",
    });
    assert.equal(input(mock).max_results, 10);
    // One request: prices ride along, unlike the old storesearch + GetItems pair.
    assert.equal(mock.calls.length, 1);
  });

  test("search_games forwards limit and per-call country/language overrides", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    await client.callTool({
      name: "search_games",
      arguments: { term: "portal", limit: 25, country: "RU", language: "russian" },
    });
    const i = input(mock);
    assert.equal(i.max_results, 25);
    assert.deepEqual(i.context, { country_code: "RU", language: "russian" });
  });

  test("games_only asks Steam to filter to games; the default sends no filter", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    await client.callTool({ name: "search_games", arguments: { term: "portal" } });
    assert.equal(input(mock).filters, undefined);
    mock.calls.length = 0;
    await client.callTool({
      name: "search_games",
      arguments: { term: "portal", games_only: true },
    });
    assert.deepEqual(input(mock).filters, { type_filters: { include_games: true } });
  });

  test("search_games rejects a limit outside 1-100 before calling the upstream", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    for (const limit of [0, 101]) {
      const res = await client.callTool({ name: "search_games", arguments: { term: "x", limit } });
      assert.equal(res.isError, true, `limit ${limit} should be rejected`);
    }
    assert.equal(mock.calls.length, 0);
  });

  // Regression: a padded country/language override (e.g. pasted with stray
  // whitespace) must still be usable — country's regex is anchored
  // (^[A-Za-z]{2}$) so untrimmed whitespace would otherwise fail validation
  // outright instead of being accepted like the trimmed value.
  test("search_games trims whitespace from per-call country/language overrides", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    const res = await client.callTool({
      name: "search_games",
      arguments: { term: "portal", country: " RU ", language: " russian " },
    });
    assert.equal(res.isError, undefined);
    assert.deepEqual(input(mock).context, { country_code: "RU", language: "russian" });
  });

  // Regression: a whitespace-only term used to pass .nonempty() (non-zero
  // length) and trigger a live, doomed search instead of a clean validation
  // error; a padded-but-real term used to run the search unstripped.
  test("search_games rejects a whitespace-only term and trims a padded one", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    const empty = await client.callTool({ name: "search_games", arguments: { term: "   " } });
    assertToolError(empty, /at least 1 character|too small/i);

    const padded = await client.callTool({
      name: "search_games",
      arguments: { term: "  portal  " },
    });
    assert.equal(padded.isError, undefined);
    assert.equal(input(mock).search_term, "portal");
  });
});

describe("get_game", () => {
  test("get_game shapes price, platforms and metacritic", async (t) => {
    const { client } = await setupServer(t, ENV, router);
    const res = await client.callTool({ name: "get_game", arguments: { appid: 620 } });
    const s = res.structuredContent as {
      appid: number;
      price: { final: string; discount_percent: number };
      platforms: string[];
      metacritic: number;
      genres: string[];
      controller_support: string;
      achievements_total: number;
      achievements_highlighted: string[];
      dlc: number[];
      supported_languages: string;
      content_descriptors: { ids: number[] };
    };
    assert.equal(s.appid, 620);
    assert.equal(s.price.final, "$1.99");
    assert.equal(s.price.discount_percent, 80);
    assert.deepEqual(s.platforms, ["windows", "linux"]);
    assert.equal(s.metacritic, 95);
    assert.deepEqual(s.genres, ["Action"]);
    assert.equal(s.controller_support, "full");
    assert.equal(s.achievements_total, 51);
    assert.deepEqual(s.achievements_highlighted, ["Wake Up Call"]);
    assert.deepEqual(s.dlc, [12345]);
    assert.equal(s.supported_languages, "English * , French"); // HTML stripped
    assert.deepEqual(s.content_descriptors.ids, [2, 5]);
  });

  test("get_game returns a not-found error for an unknown app", async (t) => {
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("/api/appdetails")) return jsonResponse({ "999": { success: false } });
      return jsonResponse({});
    });
    const res = await client.callTool({ name: "get_game", arguments: { appid: 999 } });
    // Regression: the not_found ApiError's own message (which names the
    // appid) used to be discarded for a generic "No matching resource was
    // found (404)." — asserting isError alone let that slip through silently.
    assertToolError(res, /no steam app with id 999/i);
  });

  test("get_game's not-found message names the region, since appdetails uses success:false for both", async (t) => {
    // Confirmed live: appid 1174180 is a full record under cc=US and
    // success:false under cc=RU. Saying only "no such appid" sent the agent off
    // to re-search a perfectly good one.
    const { client } = await setupServer(t, { ...ENV, STEAM_COUNTRY: "RU" }, (url) =>
      url.includes("/api/appdetails")
        ? jsonResponse({ "999": { success: false } })
        : jsonResponse({}),
    );
    const res = await client.callTool({ name: "get_game", arguments: { appid: 999 } });
    assertToolError(res, /region RU/);
    assertToolError(res, /isn't available in that country/i);
  });

  test("get_game returns a not-found error for success:true with no data (region-restricted/delisted)", async (t) => {
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("/api/appdetails")) return jsonResponse({ "999": { success: true } });
      return jsonResponse({});
    });
    const res = await client.callTool({ name: "get_game", arguments: { appid: 999 } });
    assertToolError(res, /no matching resource|404/i);
  });

  test("get_game returns a not-found error when the appid key is absent from the response entirely", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("/api/appdetails") ? jsonResponse({}) : jsonResponse({}),
    );
    const res = await client.callTool({ name: "get_game", arguments: { appid: 999 } });
    assertToolError(res, /no matching resource|404/i);
  });

  test("get_game caches: a second call for the same appid never re-hits the upstream", async (t) => {
    // Wiring check for clients/storefront.ts#getGame's wrapStaleOnError cache
    // (the stale-on-error fallback mechanism itself is unit-tested directly in
    // cache.test.ts). If the upstream were called again here, it would 503 and
    // this test would fail — proving the second call was served from cache.
    let calls = 0;
    const { client } = await setupServer(t, ENV, (url) => {
      if (!url.includes("/api/appdetails")) return jsonResponse({});
      calls++;
      if (calls === 1) return jsonResponse({ "620": { success: true, data: APP } });
      return jsonResponse({}, { status: 503 });
    });
    const first = await client.callTool({ name: "get_game", arguments: { appid: 620 } });
    assert.equal(first.isError, undefined);
    const second = await client.callTool({ name: "get_game", arguments: { appid: 620 } });
    assert.equal(second.isError, undefined);
    assert.equal(calls, 1);
  });

  test("get_game resolves a title to an appid when given name instead of appid", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    const res = await client.callTool({ name: "get_game", arguments: { name: "portal" } });
    const s = res.structuredContent as { appid: number; price: { final: string } };
    assert.equal(s.appid, 620); // resolved via storesearch (top match)
    assert.equal(s.price.final, "$1.99");
    assert.ok(mock.calls.some((c) => c.url.includes("/api/storesearch")));
  });

  // Regression: a whitespace-only name used to pass .nonempty() (non-zero
  // length) and trigger a live, doomed search instead of a clean validation
  // error; a padded-but-real name used to run the search unstripped.
  test("get_game rejects a whitespace-only name and trims a padded one", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    const empty = await client.callTool({ name: "get_game", arguments: { name: "   " } });
    assertToolError(empty, /too small/i);

    const padded = await client.callTool({ name: "get_game", arguments: { name: "  portal  " } });
    assert.equal(padded.isError, undefined);
    const u = mock.calls.find((c) => c.url.includes("/api/storesearch"))!.url;
    assert.match(u, /term=portal(?!%20)/);
  });

  test("get_game errors when neither appid nor name is given", async (t) => {
    const { client } = await setupServer(t, ENV, router);
    const res = await client.callTool({ name: "get_game", arguments: {} });
    // Enforced by the inputSchema's .refine(), not a handler-level errorResult()
    // — the SDK wraps the message in its own "Input validation error: ..."
    // prefix, so this intentionally matches loosely rather than the exact string.
    assertToolError(res, /appid or name/i);
  });

  test("get_game reports no match when the title resolves to nothing", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("/api/storesearch") ? jsonResponse({ total: 0, items: [] }) : jsonResponse({}),
    );
    const res = await client.callTool({ name: "get_game", arguments: { name: "zzzznope" } });
    assertToolError(res, /no steam game found/i);
  });
});

test("get_game_reviews summarizes score and percentage", async (t) => {
  const { client } = await setupServer(t, ENV, router);
  const res = await client.callTool({ name: "get_game_reviews", arguments: { appid: 620 } });
  const s = res.structuredContent as { summary: string; positive_pct: number };
  assert.equal(s.summary, "Overwhelmingly Positive");
  assert.equal(s.positive_pct, 90);
});

test("get_game_reviews: filtering by type nulls the summary (Steam's own appreviews only computes it for 'all')", async (t) => {
  const { client } = await setupServer(t, ENV, (url) =>
    url.includes("/appreviews/")
      ? jsonResponse({
          success: 1,
          query_summary: { num_reviews: 1 },
          reviews: [{ review: "meh", voted_up: false, votes_up: 0, author: {} }],
        })
      : jsonResponse({}),
  );
  const res = await client.callTool({
    name: "get_game_reviews",
    arguments: { appid: 620, type: "negative" },
  });
  const s = res.structuredContent as {
    summary: string | null;
    total_reviews: number | null;
    positive_pct: number | null;
  };
  assert.equal(s.summary, null);
  assert.equal(s.total_reviews, null);
  assert.equal(s.positive_pct, null);
});

test("get_specials lists discounted games with formatted prices, deduping repeated appids", async (t) => {
  const { client } = await setupServer(t, ENV, router);
  const res = await client.callTool({ name: "get_specials", arguments: {} });
  const s = res.structuredContent as {
    specials: { final_price: string; discount_percent: number }[];
  };
  // The FEATURED fixture lists appid 620 twice — Steam's own upstream does
  // this — proving the duplicate collapses to a single entry.
  assert.equal(s.specials.length, 1);
  assert.equal(s.specials[0]!.discount_percent, 80);
  assert.equal(s.specials[0]!.final_price, "1.99 USD");
});

test("get_featured returns all four store sections, defaulting missing ones to empty", async (t) => {
  const { client } = await setupServer(t, ENV, router);
  const res = await client.callTool({ name: "get_featured", arguments: {} });
  const s = res.structuredContent as {
    specials: { appid: number; discount_percent: number }[];
    top_sellers: unknown[];
    new_releases: unknown[];
    coming_soon: unknown[];
  };
  assert.equal(s.specials.length, 1);
  assert.equal(s.specials[0]!.appid, 620);
  assert.equal(s.specials[0]!.discount_percent, 80);
  assert.deepEqual(s.top_sellers, []);
  // The FEATURED fixture has no new_releases/coming_soon keys at all — proving
  // an absent section degrades to [] rather than throwing/undefined.
  assert.deepEqual(s.new_releases, []);
  assert.deepEqual(s.coming_soon, []);
});

test("get_featured drops bundle entries, whose id isn't an appid", async (t) => {
  // Live top_sellers carries bundles as type 2 (e.g. 72233, Destiny 2: The
  // Collection); emitting that id as an appid gives a store_url that redirects
  // to the front page and an appid get_game can't resolve.
  const { client } = await setupServer(t, ENV, (url) =>
    url.includes("/api/featuredcategories")
      ? jsonResponse({
          top_sellers: {
            items: [
              { id: 620, type: 0, name: "Portal 2", final_price: 999, currency: "USD" },
              { id: 72233, type: 2, name: "Destiny 2: The Collection", final_price: 2054 },
            ],
          },
        })
      : router(url),
  );
  const res = await client.callTool({ name: "get_featured", arguments: {} });
  const s = res.structuredContent as { top_sellers: { appid: number }[] };
  assert.deepEqual(
    s.top_sellers.map((i) => i.appid),
    [620],
  );
});

describe("get_prices", () => {
  test("get_prices reports available/free/unavailable rows in the requested order", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("/api/appdetails")
        ? jsonResponse({
            "620": {
              success: true,
              data: {
                price_overview: {
                  currency: "USD",
                  final_formatted: "$1.99",
                  initial_formatted: "$9.99",
                  discount_percent: 80,
                },
              },
            },
            // success with no price_overview. Steam answers this IDENTICALLY for a
            // free-to-play game and for an unreleased paid one (verified live), so the
            // row reports priced:false rather than guessing is_free:true.
            "400": { success: true, data: [] },
            "999": { success: false },
          })
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_prices",
      arguments: { appids: [620, 400, 999] },
    });
    const s = res.structuredContent as {
      count: number;
      prices: {
        appid: number;
        available: boolean;
        is_free?: boolean;
        priced?: boolean;
        final?: string;
      }[];
    };
    assert.equal(s.count, 3);
    assert.equal(s.prices[0]!.appid, 620);
    assert.equal(s.prices[0]!.available, true);
    assert.equal(s.prices[0]!.is_free, false);
    assert.equal(s.prices[0]!.final, "$1.99");
    assert.equal(s.prices[1]!.appid, 400);
    assert.equal(s.prices[1]!.available, true);
    assert.equal(s.prices[1]!.priced, false);
    assert.equal(s.prices[1]!.is_free, undefined, "freeness is not knowable from this endpoint");
    assert.equal(s.prices[2]!.appid, 999);
    assert.equal(s.prices[2]!.available, false);
  });

  test("get_prices chunks requests over 100 appids and merges them back in the original order", async (t) => {
    const { client, mock } = await setupServer(t, ENV, (url) => {
      // URLSearchParams percent-encodes the comma-joined list (e.g. "1%2C2"),
      // so parse it back out via the URL API rather than a raw regex on the string.
      const ids = new URL(url).searchParams.get("appids")?.split(",") ?? [];
      const body: Record<string, unknown> = {};
      for (const id of ids) body[id] = { success: true, data: [] }; // all free, for simplicity
      return jsonResponse(body);
    });
    const appids = Array.from({ length: 150 }, (_, i) => i + 1);
    const res = await client.callTool({ name: "get_prices", arguments: { appids } });
    const s = res.structuredContent as {
      count: number;
      prices: { appid: number; available: boolean }[];
    };
    assert.equal(s.count, 150);
    assert.deepEqual(
      s.prices.map((p) => p.appid),
      appids,
    );
    assert.ok(s.prices.every((p) => p.available));
    // 150 appids at 100 per chunk → 2 upstream calls.
    const priceCalls = mock.calls.filter((c) => c.url.includes("/api/appdetails"));
    assert.equal(priceCalls.length, 2);
  });

  test("get_prices chunks exactly on the 100-appid boundary (100 → 1 call, 101 → 2)", async (t) => {
    const { client, mock } = await setupServer(t, ENV, (url) => {
      const ids = new URL(url).searchParams.get("appids")?.split(",") ?? [];
      const body: Record<string, unknown> = {};
      for (const id of ids) body[id] = { success: true, data: [] };
      return jsonResponse(body);
    });
    await client.callTool({
      name: "get_prices",
      arguments: { appids: Array.from({ length: 100 }, (_, i) => i + 1) },
    });
    assert.equal(mock.calls.filter((c) => c.url.includes("/api/appdetails")).length, 1);

    mock.calls.length = 0;
    await client.callTool({
      name: "get_prices",
      arguments: { appids: Array.from({ length: 101 }, (_, i) => i + 1) },
    });
    assert.equal(mock.calls.filter((c) => c.url.includes("/api/appdetails")).length, 2);
  });

  test("get_prices keeps the successful chunks when one chunk fails", async (t) => {
    // The chunk loop used to await sequentially, so one chunk's 5xx threw out of
    // the loop and discarded the chunks that had already succeeded — even though
    // summarizePrices marks any missing appid available:false and the tool
    // promises "one row per id, never dropped".
    const { client } = await setupServer(
      t,
      { STEAM_STORE_MIN_INTERVAL_MS: "0", HTTP_RETRIES: "0" },
      (url) => {
        if (!url.includes("/api/appdetails")) return jsonResponse({});
        const ids = new URL(url).searchParams.get("appids")?.split(",") ?? [];
        // Key off the payload, not call order — the chunks now run concurrently.
        if (ids.includes("101")) return jsonResponse({}, { status: 500 });
        const body: Record<string, unknown> = {};
        for (const id of ids) body[id] = { success: true, data: [] };
        return jsonResponse(body);
      },
    );
    const appids = Array.from({ length: 150 }, (_, i) => i + 1);
    const res = await client.callTool({ name: "get_prices", arguments: { appids } });
    const s = res.structuredContent as {
      count: number;
      prices: { appid: number; available: boolean }[];
    };
    assert.notEqual(res.isError, true);
    assert.equal(s.count, 150);
    // First chunk survived; the failed chunk's ids degrade to available:false.
    assert.equal(s.prices.find((p) => p.appid === 1)!.available, true);
    assert.equal(s.prices.find((p) => p.appid === 100)!.available, true);
    assert.equal(s.prices.find((p) => p.appid === 101)!.available, false);
    assert.equal(s.prices.find((p) => p.appid === 150)!.available, false);
  });

  test("get_prices surfaces an error when every chunk fails (not 150 available:false rows)", async (t) => {
    const { client } = await setupServer(
      t,
      { STEAM_STORE_MIN_INTERVAL_MS: "0", HTTP_RETRIES: "0" },
      (url) =>
        url.includes("/api/appdetails") ? jsonResponse({}, { status: 500 }) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_prices",
      arguments: { appids: Array.from({ length: 150 }, (_, i) => i + 1) },
    });
    assert.equal(res.isError, true);
  });

  test("get_prices reports unavailable when an appid's key is entirely absent from the response", async (t) => {
    // Distinct from an explicit {success:false} entry — Steam can just omit
    // the key altogether for some appids in a batch response.
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("/api/appdetails") ? jsonResponse({}) : jsonResponse({}),
    );
    const res = await client.callTool({ name: "get_prices", arguments: { appids: [999] } });
    const s = res.structuredContent as { prices: { appid: number; available: boolean }[] };
    assert.equal(s.prices[0]!.available, false);
  });

  test(`get_prices rejects appids outside the 1-${PRICES_MAX} bound before calling the upstream`, async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    const tooMany = await client.callTool({
      name: "get_prices",
      arguments: { appids: Array.from({ length: PRICES_MAX + 1 }, (_, i) => i + 1) },
    });
    assert.equal(tooMany.isError, true);
    const empty = await client.callTool({ name: "get_prices", arguments: { appids: [] } });
    assert.equal(empty.isError, true);
    assert.equal(mock.calls.filter((c) => c.url.includes("/api/appdetails")).length, 0);
  });

  // The one test in this file that drives the client directly rather than a
  // tool: get_prices' schema is .nonempty(), so an empty list can't reach
  // getPrices through the MCP surface at all — and the all-chunks-failed
  // rethrow used to read `settled[0].reason` off an empty array for exactly
  // that input, throwing a TypeError instead of answering. A client method
  // shouldn't rely on one caller's validation to avoid crashing.
  test("getPrices answers an empty appid list instead of throwing on settled[0]", async (t) => {
    const mock = mockFetch(() => jsonResponse({}));
    installFetch(t, mock);
    const store = new StorefrontClient(loadConfig({}), silentLogger(), {
      getPurchasePrices: async () => ({}),
    });
    assert.deepEqual(await store.getPrices([]), { count: 0, prices: [] });
    assert.equal(mock.calls.length, 0, "no chunks means no upstream call");
  });
});

test("get_review_histogram returns history and recent with positive %", async (t) => {
  const { client } = await setupServer(t, { STEAM_STORE_MIN_INTERVAL_MS: "0" }, router);
  const res = await client.callTool({ name: "get_review_histogram", arguments: { appid: 620 } });
  const s = res.structuredContent as {
    rollup_type: string;
    history: { positive_pct: number }[];
    recent: { up: number; down: number; positive_pct: number }[];
  };
  assert.equal(s.rollup_type, "month");
  assert.equal(s.history[0]!.positive_pct, 100); // 754 up / 1 down → 100%
  assert.equal(s.recent[0]!.up, 66);
  assert.equal(s.recent[0]!.positive_pct, 97); // 66 / 68
});

describe("zod input boundaries are rejected before reaching the client", () => {
  test("get_game_reviews' limit rejects 0 and 21, accepts 1 and 20", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    for (const bad of [0, 21]) {
      const res = await client.callTool({
        name: "get_game_reviews",
        arguments: { appid: 620, limit: bad },
      });
      assert.equal(res.isError, true, `limit ${bad} should be rejected`);
    }
    assert.equal(mock.calls.filter((c) => c.url.includes("/appreviews/")).length, 0);
    for (const ok of [1, 20]) {
      const res = await client.callTool({
        name: "get_game_reviews",
        arguments: { appid: 620, limit: ok },
      });
      assert.equal(res.isError, undefined, `limit ${ok} should be accepted`);
    }
  });

  test("appid rejects 0 and negative values", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    for (const bad of [0, -1]) {
      const res = await client.callTool({
        name: "get_review_histogram",
        arguments: { appid: bad },
      });
      assert.equal(res.isError, true, `appid ${bad} should be rejected`);
    }
    assert.equal(mock.calls.filter((c) => c.url.includes("/appreviewhistogram/")).length, 0);
  });
});

test("get_game (by name) skips a non-numeric top search result and resolves the next one", async (t) => {
  // resolveAppId's `res.items?.find((i) => typeof i.id === "number")` — a
  // bundle/sub can rank above the real app and carries no numeric id.
  const { client } = await setupServer(t, ENV, (url) => {
    if (url.includes("/api/storesearch")) {
      return jsonResponse({
        total: 2,
        items: [
          { type: "bundle", name: "Portal Bundle" }, // no numeric id
          { type: "app", name: "Portal 2", id: 620 },
        ],
      });
    }
    if (url.includes("/api/appdetails"))
      return jsonResponse({ "620": { success: true, data: APP } });
    return jsonResponse({});
  });
  const res = await client.callTool({ name: "get_game", arguments: { name: "portal" } });
  const s = res.structuredContent as { appid: number };
  assert.equal(s.appid, 620);
});

// The pieces of upstream-failure handling (classifyStatus, messageFor,
// HttpClient's retry/backoff) each have unit tests of their own, but nothing
// exercised them wired together end-to-end through a real tool call. These
// confirm a genuine transport-level failure — not an application-level
// "not found" — actually reaches the agent as an actionable isError:true.
describe("genuine upstream failures propagate as actionable tool errors", () => {
  test("a persistent 5xx from the store (retries exhausted) surfaces the 'retry later' message", async (t) => {
    const { client } = await setupServer(t, { HTTP_RETRIES: "0" }, () =>
      jsonResponse({}, { status: 503 }),
    );
    const res = await client.callTool({ name: "get_game", arguments: { appid: 620 } });
    assertToolError(res, /5xx|retry later/i);
  });

  test("a network failure (fetch rejects) surfaces a clear network error, not a crash", async (t) => {
    const { client } = await setupServer(t, { HTTP_RETRIES: "0" }, () => {
      throw new Error("getaddrinfo ENOTFOUND store.steampowered.com");
    });
    const res = await client.callTool({ name: "get_specials", arguments: {} });
    assertToolError(res, /network/i);
  });

  test("a malformed (non-JSON) 200 response surfaces as an actionable error", async (t) => {
    const { client } = await setupServer(
      t,
      { HTTP_RETRIES: "0" },
      () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const res = await client.callTool({ name: "get_game", arguments: { appid: 620 } });
    assertToolError(res, /invalid json/i);
  });
});

// The upgrade-SKU trap: Steam's Storefront API fills appdetails' price_overview
// and storesearch's price from the FIRST sub of an app's default package group,
// which for appid 3717330 (Yakuza Kiwami, cc=ID) is the Rp 20 000 upgrade for
// owners of the Legacy version rather than the Rp 200 000 → Rp 120 000 base
// game. Numbers taken from live responses on 2026-08-25; see
// format/storefront.ts's overridePrice() for the full write-up.
const TRAP_APPID = 3717330;
const TRAP_PRICE_OVERVIEW = {
  currency: "IDR",
  final_formatted: "Rp 20 000",
  initial_formatted: "", // Steam empties this when it thinks there's no discount
  discount_percent: 0,
};
const TRAP_APP = { name: "Yakuza Kiwami", steam_appid: TRAP_APPID, is_free: false };
const TRAP_ITEMS = {
  response: {
    store_items: [
      {
        appid: TRAP_APPID,
        name: "Yakuza Kiwami",
        best_purchase_option: {
          packageid: 1308688, // the base game, not the Rp 20 000 upgrade sub
          formatted_final_price: "Rp 120 000",
          formatted_original_price: "Rp 200 000",
          discount_pct: 40,
        },
      },
    ],
  },
};

/** Answer all three Storefront endpoints with the trap app, and GetItems with
 *  whatever the test wants to see happen to the correction. */
function trapRouter(items: unknown = TRAP_ITEMS, itemsStatus = 200) {
  return (url: string) => {
    if (url.includes("IStoreBrowseService/GetItems"))
      return jsonResponse(items, { status: itemsStatus });
    if (url.includes("/api/storesearch"))
      return jsonResponse({
        total: 1,
        items: [
          {
            type: "app",
            name: "Yakuza Kiwami",
            id: TRAP_APPID,
            price: { currency: "IDR", initial: 2000000, final: 2000000 },
          },
        ],
      });
    if (url.includes("/api/appdetails"))
      return jsonResponse({
        [String(TRAP_APPID)]: {
          success: true,
          data: { ...TRAP_APP, price_overview: TRAP_PRICE_OVERVIEW },
        },
      });
    return jsonResponse({});
  };
}

type PriceShape = { currency: string; final: string; initial: string; discount_percent: number };

describe("price_overview correction", () => {
  test("get_game reports the base game, not the upgrade SKU price_overview names", async (t) => {
    const { client } = await setupServer(t, ENV, trapRouter());
    const res = await client.callTool({ name: "get_game", arguments: { appid: TRAP_APPID } });
    const s = res.structuredContent as { price: PriceShape };
    assert.equal(s.price.final, "Rp 120 000");
    assert.equal(s.price.initial, "Rp 200 000");
    assert.equal(s.price.discount_percent, 40);
    // GetItems returns no currency code, so this one still comes from appdetails.
    assert.equal(s.price.currency, "IDR");
  });

  test("a failed price lookup isn't cached into get_game: the next call corrects it", async (t) => {
    // getPurchasePrices degrades a failed GetItems to "no corrections" instead
    // of throwing. Inside get_game's cache entry that degraded answer used to
    // be stored, pinning the upgrade-SKU price for the whole TTL.
    let itemsUp = false;
    const base = trapRouter();
    const { client, mock } = await setupServer(t, ENV, (url) =>
      url.includes("IStoreBrowseService/GetItems") && !itemsUp
        ? jsonResponse({}, { status: 500 })
        : base(url),
    );
    const call = async () =>
      (
        (await client.callTool({ name: "get_game", arguments: { appid: TRAP_APPID } }))
          .structuredContent as { price: PriceShape }
      ).price;
    assert.equal((await call()).final, "Rp 20 000");
    itemsUp = true;
    assert.equal((await call()).final, "Rp 120 000");
    // appdetails itself stayed cached; only the price lookup was retried.
    assert.equal(mock.calls.filter((c) => c.url.includes("/api/appdetails")).length, 1);
    // ...and a successful lookup is cached in turn: no further GetItems call.
    const before = mock.calls.length;
    assert.equal((await call()).final, "Rp 120 000");
    assert.equal(mock.calls.length, before);
  });

  test("get_prices never serves a cached correction over its fresh Storefront row", async (t) => {
    // get_prices fetches appdetails fresh; a correction cached for the TTL
    // would hide a sale that started since the last call.
    let discount = 0;
    const items = () => ({
      response: {
        store_items: [
          {
            ...TRAP_ITEMS.response.store_items[0],
            best_purchase_option: {
              ...TRAP_ITEMS.response.store_items[0]!.best_purchase_option,
              discount_pct: discount,
            },
          },
        ],
      },
    });
    const base = trapRouter();
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("IStoreBrowseService/GetItems") ? jsonResponse(items()) : base(url),
    );
    const pct = async () =>
      (
        (await client.callTool({ name: "get_prices", arguments: { appids: [TRAP_APPID] } }))
          .structuredContent as { prices: { discount_percent: number }[] }
      ).prices[0]!.discount_percent;
    assert.equal(await pct(), 0);
    discount = 40;
    assert.equal(await pct(), 40);
  });

  test("get_prices corrects the amounts and keeps currency, is_free and available", async (t) => {
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("IStoreBrowseService/GetItems")) return jsonResponse(TRAP_ITEMS);
      if (url.includes("/api/appdetails"))
        return jsonResponse({
          [String(TRAP_APPID)]: { success: true, data: { price_overview: TRAP_PRICE_OVERVIEW } },
        });
      return jsonResponse({});
    });
    const res = await client.callTool({ name: "get_prices", arguments: { appids: [TRAP_APPID] } });
    const s = res.structuredContent as {
      prices: (PriceShape & { available: boolean; is_free: boolean })[];
    };
    assert.equal(s.prices[0]!.available, true);
    assert.equal(s.prices[0]!.is_free, false);
    assert.equal(s.prices[0]!.final, "Rp 120 000");
    assert.equal(s.prices[0]!.initial, "Rp 200 000");
    assert.equal(s.prices[0]!.discount_percent, 40);
    assert.equal(s.prices[0]!.currency, "IDR");
  });

  test("a row Steam prices at nothing is left alone, not given the lookup's price", async (t) => {
    // appdetails omits price_overview for a free (or not-yet-priced) game;
    // GetItems still quoting a purchase option (a paid bundle/upgrade sub) must
    // not invent a price for it — overridePrice() only corrects a row that
    // already has one, so the row stays priced:false.
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("IStoreBrowseService/GetItems")) return jsonResponse(TRAP_ITEMS);
      if (url.includes("/api/appdetails"))
        return jsonResponse({ [String(TRAP_APPID)]: { success: true, data: [] } });
      return jsonResponse({});
    });
    const res = await client.callTool({ name: "get_prices", arguments: { appids: [TRAP_APPID] } });
    const s = res.structuredContent as { prices: { priced?: boolean; final?: string }[] };
    assert.equal(s.prices[0]!.priced, false);
    assert.equal(s.prices[0]!.final, undefined);
  });

  test("a bundle price never overrides — it prices a set of games, not this one", async (t) => {
    // Measured on Steam's top 500 US sellers: 5 of 421 priced apps report a
    // bundle as their best purchase option, e.g. appid 2186680 at $48.36 for
    // "The Darkest Grimdark Bundle" when the game itself is $49.99. Trusting
    // those would swap a rare wrong price for a commoner one.
    const { client } = await setupServer(
      t,
      ENV,
      trapRouter({
        response: {
          store_items: [
            {
              appid: TRAP_APPID,
              best_purchase_option: {
                bundleid: 67187, // a bundle containing this app, no packageid
                formatted_final_price: "Rp 99 000",
                discount_pct: 60,
              },
            },
          ],
        },
      }),
    );
    const res = await client.callTool({ name: "get_game", arguments: { appid: TRAP_APPID } });
    const s = res.structuredContent as { price: PriceShape };
    assert.equal(s.price.final, "Rp 20 000");
    assert.equal(s.price.discount_percent, 0);
  });

  test("a paid own package outranks appdetails flagging the game free", async (t) => {
    // appdetails calls theHunter: Call of the Wild (appid 518790) free because
    // its default group opens with the free upgrade for Classic owners, so
    // get_game reported a $19.99 game as free until the override outranked it.
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("IStoreBrowseService/GetItems"))
        return jsonResponse({
          response: {
            store_items: [
              {
                appid: 518790,
                best_purchase_option: { packageid: 121558, formatted_final_price: "$19.99" },
              },
            ],
          },
        });
      if (url.includes("/api/appdetails"))
        return jsonResponse({
          "518790": {
            success: true,
            data: {
              name: "theHunter: Call of the Wild",
              steam_appid: 518790,
              is_free: true,
              price_overview: { currency: "USD", final_formatted: "Free", discount_percent: 0 },
            },
          },
        });
      return jsonResponse({});
    });
    const res = await client.callTool({ name: "get_game", arguments: { appid: 518790 } });
    const s = res.structuredContent as {
      is_free: boolean;
      price: PriceShape & { is_free: boolean };
    };
    assert.equal(s.price.final, "$19.99");
    assert.equal(s.price.is_free, false);
    // The two must agree — a price block saying $19.99 next to is_free:true is
    // worse than either answer alone.
    assert.equal(s.is_free, false);
  });

  test("a genuinely free game GetItems prices at $0.00 gets no override", async (t) => {
    // Dokimon Quest (appid 2019300): free, and GetItems says so alongside a
    // $0.00 own package. Overriding would render "Free" as "$0.00".
    const { client } = await setupServer(
      t,
      ENV,
      trapRouter({
        response: {
          store_items: [
            {
              appid: TRAP_APPID,
              is_free: true,
              best_purchase_option: { packageid: 1789456, formatted_final_price: "$0.00" },
            },
          ],
        },
      }),
    );
    const res = await client.callTool({ name: "get_game", arguments: { appid: TRAP_APPID } });
    const s = res.structuredContent as { price: PriceShape };
    assert.equal(s.price.final, "Rp 20 000");
  });

  test("get_game keeps the Storefront price when the lookup has no option for the appid", async (t) => {
    const { client } = await setupServer(t, ENV, trapRouter({ response: { store_items: [] } }));
    const res = await client.callTool({ name: "get_game", arguments: { appid: TRAP_APPID } });
    const s = res.structuredContent as { price: PriceShape };
    assert.equal(s.price.final, "Rp 20 000");
    assert.equal(s.price.discount_percent, 0);
  });

  test("get_game still answers when the price lookup fails outright", async (t) => {
    // The correction is an enrichment: losing it must cost the price's accuracy,
    // never the whole tool call.
    const { client } = await setupServer(
      t,
      { ...ENV, HTTP_RETRIES: "0" },
      trapRouter({ error: "nope" }, 500),
    );
    const res = await client.callTool({ name: "get_game", arguments: { appid: TRAP_APPID } });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { name: string; price: PriceShape };
    assert.equal(s.name, "Yakuza Kiwami");
    assert.equal(s.price.final, "Rp 20 000");
  });

  test("a malformed lookup payload costs the correction, not the tool call", async (t) => {
    // The shaper throws on a payload its schema rejects; the outer Promise.all
    // in getGame/getPrices would otherwise turn that into a failed tool call.
    const { client } = await setupServer(
      t,
      ENV,
      trapRouter({
        response: {
          store_items: [
            {
              appid: TRAP_APPID,
              best_purchase_option: { packageid: 1308688, formatted_final_price: 12000 },
            },
          ],
        },
      }),
    );
    const res = await client.callTool({ name: "get_game", arguments: { appid: TRAP_APPID } });
    assert.equal(res.isError, undefined);
    assert.equal((res.structuredContent as { price: PriceShape }).price.final, "Rp 20 000");
  });

  test(`the price lookup chunks at ${PRICE_LOOKUP_CHUNK} appids`, async (t) => {
    const { client, mock } = await setupServer(t, ENV, () => jsonResponse({}));
    const appids = Array.from({ length: PRICES_MAX }, (_, i) => i + 1);
    await client.callTool({ name: "get_prices", arguments: { appids } });
    const lookups = mock.calls.filter((c) => c.url.includes("IStoreBrowseService/GetItems"));
    assert.equal(lookups.length, Math.ceil(PRICES_MAX / PRICE_LOOKUP_CHUNK));
    // Every requested appid appears across the chunks exactly once.
    const sent = lookups.flatMap(
      (c) =>
        (
          JSON.parse(new URL(c.url).searchParams.get("input_json")!) as {
            ids: { appid: number }[];
          }
        ).ids,
    );
    assert.deepEqual(
      sent.map((i) => i.appid),
      appids,
    );
  });
});
