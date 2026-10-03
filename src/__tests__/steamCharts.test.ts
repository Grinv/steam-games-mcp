// Integration tests for get_charts (keyless): top_sellers, most_played and
// concurrent_players — mirrors tools/webStore.ts's get_charts registration.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupServer, jsonResponse, assertToolError } from "./helpers.js";
import { router } from "./steamFixtures.js";

const ENV = { STEAM_API_MIN_INTERVAL_MS: "0", STEAM_STORE_MIN_INTERVAL_MS: "0" };

const TOP_SELLERS = {
  response: {
    start_date: 1790035200,
    ranks: [
      {
        rank: 1,
        appid: 4080220,
        item: { name: "EA SPORTS FC 27" },
        last_week_rank: 2,
        consecutive_weeks: 10,
      },
      // A new entry: Steam omits last_week_rank entirely.
      { rank: 2, appid: 1888930, item: { name: "Newcomer" }, consecutive_weeks: 1 },
      {
        rank: 3,
        appid: 730,
        item: { name: "Counter-Strike 2" },
        last_week_rank: 3,
        consecutive_weeks: 738,
      },
    ],
  },
};
const MOST_PLAYED = {
  response: {
    rollup_date: 1790899200,
    ranks: [
      { rank: 1, appid: 730, last_week_rank: 1, peak_in_game: 1160588 },
      { rank: 2, appid: 570, last_week_rank: 0, peak_in_game: 790564 },
      { rank: 3, appid: 578080, last_week_rank: 3, peak_in_game: 605728 },
    ],
  },
};
const CONCURRENT = {
  response: {
    last_update: 1790999541,
    ranks: [
      { rank: 1, appid: 730, concurrent_in_game: 516559, peak_in_game: 1160588 },
      { rank: 2, appid: 570, concurrent_in_game: 434781, peak_in_game: 790564 },
    ],
  },
};
const NAMES = {
  response: {
    store_items: [
      { appid: 730, name: "Counter-Strike 2" },
      { appid: 570, name: "Dota 2" },
    ],
  },
};

function chartsRouter(over: { names?: () => Response } = {}) {
  return (url: string) => {
    if (url.includes("GetWeeklyTopSellers")) return jsonResponse(TOP_SELLERS);
    if (url.includes("GetMostPlayedGames")) return jsonResponse(MOST_PLAYED);
    if (url.includes("GetGamesByConcurrentPlayers")) return jsonResponse(CONCURRENT);
    if (url.includes("IStoreBrowseService/GetItems") && over.names) return over.names();
    if (url.includes("IStoreBrowseService/GetItems")) return jsonResponse(NAMES);
    return router(url);
  };
}

type Entry = Record<string, unknown>;
type Out = { chart: string; as_of: string | null; count: number; entries: Entry[] };

describe("get_charts", () => {
  test("rejects a `country`: every chart is a global ranking", async (t) => {
    // Verified live 2026-10-03: GetWeeklyTopSellers returns the identical
    // order for US, JP and RU, so a country argument would only mislead.
    const { client, mock } = await setupServer(t, ENV, chartsRouter());
    const res = await client.callTool({
      name: "get_charts",
      arguments: { chart: "top_sellers", country: "DE" },
    });
    assert.equal(res.isError, true);
    assert.equal(mock.calls.length, 0);
  });

  test("top_sellers returns names from the chart itself, with new entries as null", async (t) => {
    const { client, mock } = await setupServer(t, ENV, chartsRouter());
    const res = await client.callTool({
      name: "get_charts",
      arguments: { chart: "top_sellers", limit: 3 },
    });
    const s = res.structuredContent as Out;
    assert.equal(s.chart, "top_sellers");
    assert.equal(s.as_of, "2026-09-22T00:00:00Z");
    assert.equal(s.count, 3);
    assert.deepEqual(s.entries[0], {
      rank: 1,
      appid: 4080220,
      name: "EA SPORTS FC 27",
      store_url: "https://store.steampowered.com/app/4080220",
      last_week_rank: 2,
      consecutive_weeks: 10,
    });
    assert.equal(s.entries[1]!.last_week_rank, null);
    const u = decodeURIComponent(
      mock.calls.find((c) => c.url.includes("GetWeeklyTopSellers"))!.url,
    );
    assert.match(u, /"page_count":3/);
    // Names ride along on each rank: no GetItems lookup for this chart.
    assert.ok(!mock.calls.some((c) => c.url.includes("IStoreBrowseService/GetItems")));
  });

  test("most_played resolves names in one batched call and maps last_week_rank 0 to null", async (t) => {
    const { client, mock } = await setupServer(t, ENV, chartsRouter());
    const res = await client.callTool({
      name: "get_charts",
      arguments: { chart: "most_played", limit: 3 },
    });
    const s = res.structuredContent as Out;
    assert.equal(s.chart, "most_played");
    assert.equal(s.count, 3);
    assert.equal(s.entries[0]!.name, "Counter-Strike 2");
    assert.equal(s.entries[0]!.peak_in_game, 1160588);
    assert.equal(s.entries[1]!.last_week_rank, null);
    assert.equal(s.entries[2]!.name, null); // not in the lookup response
    assert.equal(
      mock.calls.filter((c) => c.url.includes("IStoreBrowseService/GetItems")).length,
      1,
    );
  });

  test("concurrent_players returns live and peak counts, and no last_week_rank", async (t) => {
    const { client } = await setupServer(t, ENV, chartsRouter());
    const res = await client.callTool({
      name: "get_charts",
      arguments: { chart: "concurrent_players" },
    });
    const s = res.structuredContent as Out;
    assert.equal(s.chart, "concurrent_players");
    assert.equal(s.as_of, new Date(1790999541 * 1000).toISOString().replace(".000Z", "Z"));
    assert.equal(s.entries[0]!.concurrent_in_game, 516559);
    assert.equal(s.entries[0]!.peak_in_game, 1160588);
    assert.equal("last_week_rank" in s.entries[0]!, false);
  });

  test("limit trims the chart and the name lookup", async (t) => {
    const { client, mock } = await setupServer(t, ENV, chartsRouter());
    const res = await client.callTool({
      name: "get_charts",
      arguments: { chart: "most_played", limit: 1 },
    });
    assert.equal((res.structuredContent as Out).count, 1);
    const lookup = decodeURIComponent(
      mock.calls.find((c) => c.url.includes("IStoreBrowseService/GetItems"))!.url,
    );
    assert.match(lookup, /"ids":\[\{"appid":730\}\]/);
  });

  test("the default limit is 20 and limits outside 1-100 are rejected", async (t) => {
    const { client, mock } = await setupServer(t, ENV, chartsRouter());
    await client.callTool({ name: "get_charts", arguments: { chart: "top_sellers" } });
    const u = decodeURIComponent(
      mock.calls.find((c) => c.url.includes("GetWeeklyTopSellers"))!.url,
    );
    assert.match(u, /"page_count":20/);
    for (const limit of [0, 101]) {
      const bad = await client.callTool({
        name: "get_charts",
        arguments: { chart: "top_sellers", limit },
      });
      assert.equal(bad.isError, true);
    }
  });

  test("a failed name lookup degrades to null names instead of failing the chart", async (t) => {
    const { client } = await setupServer(
      t,
      ENV,
      chartsRouter({ names: () => jsonResponse({}, { status: 500 }) }),
    );
    const res = await client.callTool({
      name: "get_charts",
      arguments: { chart: "concurrent_players", limit: 2 },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as Out;
    assert.equal(s.count, 2);
    assert.deepEqual(
      s.entries.map((e) => e.name),
      [null, null],
    );
  });

  test("an upstream chart failure is a tool error", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("ISteamChartsService") ? jsonResponse({}, { status: 500 }) : router(url),
    );
    const res = await client.callTool({
      name: "get_charts",
      arguments: { chart: "most_played" },
    });
    assertToolError(res, /.+/);
  });

  test("rejects an unknown chart", async (t) => {
    const { client } = await setupServer(t, ENV, chartsRouter());
    const res = await client.callTool({ name: "get_charts", arguments: { chart: "bogus" } });
    assert.equal(res.isError, true);
  });
});
