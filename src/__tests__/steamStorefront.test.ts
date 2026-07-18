// Integration tests for the keyless Storefront tools (search_games, get_game,
// get_game_reviews, get_specials, get_review_histogram) — mirrors
// tools/storefront.ts. Split out of a single steam.test.ts once it grew past
// 1600 lines; see steamCatalog.test.ts (keyless Web API store tools) and
// steamPlayer.test.ts (key-gated player tools) for the rest.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupServer, jsonResponse, assertToolError } from "./helpers.js";
import { ENV, router } from "./steamFixtures.js";

test("the server advertises store and player tools", async (t) => {
  const { client } = await setupServer(t, ENV, router);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    "search_games",
    "get_game",
    "get_specials",
    "get_player_summary",
    "resolve_vanity_url",
  ]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
});

describe("search_games", () => {
  test("search_games returns appids", async (t) => {
    const { client } = await setupServer(t, ENV, router);
    const res = await client.callTool({ name: "search_games", arguments: { term: "portal" } });
    const s = res.structuredContent as { results: { appid: number; name: string }[] };
    assert.equal(s.results[0]!.appid, 620);
    assert.equal(s.results[0]!.name, "Portal 2");
  });

  test("search_games forwards per-call country/language overrides", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    await client.callTool({
      name: "search_games",
      arguments: { term: "portal", country: "RU", language: "russian" },
    });
    const u = mock.calls.find((c) => c.url.includes("/api/storesearch"))!.url;
    assert.match(u, /cc=RU/);
    assert.match(u, /l=russian/);
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
    assert.equal(res.isError, true);
  });

  test("get_game resolves a title to an appid when given name instead of appid", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    const res = await client.callTool({ name: "get_game", arguments: { name: "portal" } });
    const s = res.structuredContent as { appid: number; price: { final: string } };
    assert.equal(s.appid, 620); // resolved via storesearch (top match)
    assert.equal(s.price.final, "$1.99");
    assert.ok(mock.calls.some((c) => c.url.includes("/api/storesearch")));
  });

  test("get_game errors when neither appid nor name is given", async (t) => {
    const { client } = await setupServer(t, ENV, router);
    const res = await client.callTool({ name: "get_game", arguments: {} });
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

test("get_specials lists discounted games with formatted prices", async (t) => {
  const { client } = await setupServer(t, ENV, router);
  const res = await client.callTool({ name: "get_specials", arguments: {} });
  const s = res.structuredContent as {
    specials: { final_price: string; discount_percent: number }[];
  };
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
  assert.equal(s.specials[0]!.appid, 620);
  assert.equal(s.specials[0]!.discount_percent, 80);
  assert.deepEqual(s.top_sellers, []);
  // The FEATURED fixture has no new_releases/coming_soon keys at all — proving
  // an absent section degrades to [] rather than throwing/undefined.
  assert.deepEqual(s.new_releases, []);
  assert.deepEqual(s.coming_soon, []);
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
            "400": { success: true, data: [] }, // free game: no price_overview
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
      prices: { appid: number; available: boolean; is_free?: boolean; final?: string }[];
    };
    assert.equal(s.count, 3);
    assert.equal(s.prices[0]!.appid, 620);
    assert.equal(s.prices[0]!.available, true);
    assert.equal(s.prices[0]!.is_free, false);
    assert.equal(s.prices[0]!.final, "$1.99");
    assert.equal(s.prices[1]!.appid, 400);
    assert.equal(s.prices[1]!.available, true);
    assert.equal(s.prices[1]!.is_free, true);
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
