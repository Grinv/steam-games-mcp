// Integration tests for the keyless Storefront tools (search_games, get_game,
// get_game_reviews, get_specials, get_review_histogram) — mirrors
// tools/storefront.ts. Split out of a single steam.test.ts once it grew past
// 1600 lines; see steamCatalog.test.ts (keyless Web API store tools) and
// steamPlayer.test.ts (key-gated player tools) for the rest.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { connectServer, installFetch, mockFetch, jsonResponse } from "./helpers.js";
import { ENV, router } from "./steamFixtures.js";

test("the server advertises store and player tools", async (t) => {
  const { client, close } = await connectServer(ENV);
  t.after(close);
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
    installFetch(t, mockFetch(router));
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({ name: "search_games", arguments: { term: "portal" } });
    const s = res.structuredContent as { results: { appid: number; name: string }[] };
    assert.equal(s.results[0]!.appid, 620);
    assert.equal(s.results[0]!.name, "Portal 2");
  });

  test("search_games forwards per-call country/language overrides", async (t) => {
    const mock = mockFetch(router);
    installFetch(t, mock);
    const { client, close } = await connectServer(ENV);
    t.after(close);
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
    installFetch(t, mockFetch(router));
    const { client, close } = await connectServer(ENV);
    t.after(close);
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
    installFetch(
      t,
      mockFetch((url) => {
        if (url.includes("/api/appdetails")) return jsonResponse({ "999": { success: false } });
        return jsonResponse({});
      }),
    );
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({ name: "get_game", arguments: { appid: 999 } });
    assert.equal(res.isError, true);
  });

  test("get_game resolves a title to an appid when given name instead of appid", async (t) => {
    const mock = mockFetch(router);
    installFetch(t, mock);
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({ name: "get_game", arguments: { name: "portal" } });
    const s = res.structuredContent as { appid: number; price: { final: string } };
    assert.equal(s.appid, 620); // resolved via storesearch (top match)
    assert.equal(s.price.final, "$1.99");
    assert.ok(mock.calls.some((c) => c.url.includes("/api/storesearch")));
  });

  test("get_game errors when neither appid nor name is given", async (t) => {
    installFetch(t, mockFetch(router));
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({ name: "get_game", arguments: {} });
    assert.equal(res.isError, true);
    assert.match((res.content as { text: string }[])[0]!.text, /appid or name/i);
  });

  test("get_game reports no match when the title resolves to nothing", async (t) => {
    installFetch(
      t,
      mockFetch((url) =>
        url.includes("/api/storesearch") ? jsonResponse({ total: 0, items: [] }) : jsonResponse({}),
      ),
    );
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({ name: "get_game", arguments: { name: "zzzznope" } });
    assert.equal(res.isError, true);
    assert.match((res.content as { text: string }[])[0]!.text, /no steam game found/i);
  });
});

test("get_game_reviews summarizes score and percentage", async (t) => {
  installFetch(t, mockFetch(router));
  const { client, close } = await connectServer(ENV);
  t.after(close);
  const res = await client.callTool({ name: "get_game_reviews", arguments: { appid: 620 } });
  const s = res.structuredContent as { summary: string; positive_pct: number };
  assert.equal(s.summary, "Overwhelmingly Positive");
  assert.equal(s.positive_pct, 90);
});

test("get_specials lists discounted games with formatted prices", async (t) => {
  installFetch(t, mockFetch(router));
  const { client, close } = await connectServer(ENV);
  t.after(close);
  const res = await client.callTool({ name: "get_specials", arguments: {} });
  const s = res.structuredContent as {
    specials: { final_price: string; discount_percent: number }[];
  };
  assert.equal(s.specials[0]!.discount_percent, 80);
  assert.equal(s.specials[0]!.final_price, "1.99 USD");
});

test("get_review_histogram returns history and recent with positive %", async (t) => {
  installFetch(t, mockFetch(router));
  const { client, close } = await connectServer({ STEAM_STORE_MIN_INTERVAL_MS: "0" });
  t.after(close);
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
