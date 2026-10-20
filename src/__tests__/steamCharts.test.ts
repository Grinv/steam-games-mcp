// Integration tests for get_charts (keyless): top_sellers, most_played,
// most_played_deck and concurrent_players — mirrors tools/webStore.ts's get_charts registration.
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
      {
        rank: 1,
        appid: 730,
        item: { name: "Counter-Strike 2" },
        last_week_rank: 1,
        peak_in_game: 1160588,
      },
      { rank: 2, appid: 570, item: { name: "Dota 2" }, last_week_rank: 0, peak_in_game: 790564 },
      // No item: a name Steam didn't send stays null.
      { rank: 3, appid: 578080, last_week_rank: 3, peak_in_game: 605728 },
    ],
  },
};
const CONCURRENT = {
  response: {
    last_update: 1790999541,
    ranks: [
      {
        rank: 1,
        appid: 730,
        item: { name: "Counter-Strike 2" },
        concurrent_in_game: 516559,
        peak_in_game: 1160588,
      },
      {
        rank: 2,
        appid: 570,
        item: { name: "Dota 2" },
        concurrent_in_game: 434781,
        peak_in_game: 790564,
      },
    ],
  },
};
// Shape verified live 2026-10-20: names ride along on `item`, no date field,
// and a new entry's last_period_rank is -1.
const DECK = {
  response: {
    ranks: [
      { rank: 1, appid: 2868840, item: { name: "Slay the Spire 2" }, last_period_rank: 1 },
      { rank: 2, appid: 4231820, item: { name: "Newcomer" }, last_period_rank: -1 },
    ],
    top_played_period: 1,
  },
};
function chartsRouter() {
  return (url: string) => {
    if (url.includes("GetWeeklyTopSellers")) return jsonResponse(TOP_SELLERS);
    if (url.includes("GetMostPlayedGames")) return jsonResponse(MOST_PLAYED);
    if (url.includes("GetMostPlayedSteamDeckGames")) return jsonResponse(DECK);
    if (url.includes("GetGamesByConcurrentPlayers")) return jsonResponse(CONCURRENT);
    return router(url);
  };
}

type Entry = Record<string, unknown>;
type Out = { chart: string; as_of: string | null; count: number; entries: Entry[] };

describe("get_charts", () => {
  test("top_sellers takes a country (top-level country_code) and a week (start_date)", async (t) => {
    // Verified live 2026-10-20: only the request's TOP-LEVEL country_code
    // changes the ranking (DE/BR/JP each differ from global); context alone
    // doesn't. start_date is snapped by Steam to the week containing it.
    const { client, mock } = await setupServer(t, ENV, chartsRouter());
    await client.callTool({
      name: "get_charts",
      arguments: { chart: "top_sellers", country: "de", week: "2026-03-05" },
    });
    const input = JSON.parse(
      new URL(mock.calls.find((c) => c.url.includes("GetWeeklyTopSellers"))!.url).searchParams.get(
        "input_json",
      )!,
    ) as { country_code?: string; start_date?: number };
    assert.equal(input.country_code, "DE");
    assert.equal(input.start_date, Date.UTC(2026, 2, 5) / 1000);
  });

  test("top_sellers without a country is the global chart (no top-level country_code)", async (t) => {
    const { client, mock } = await setupServer(t, ENV, chartsRouter());
    await client.callTool({ name: "get_charts", arguments: { chart: "top_sellers" } });
    const input = JSON.parse(
      new URL(mock.calls.find((c) => c.url.includes("GetWeeklyTopSellers"))!.url).searchParams.get(
        "input_json",
      )!,
    ) as { country_code?: string; start_date?: number };
    assert.equal(input.country_code, undefined);
    assert.equal(input.start_date, undefined);
  });

  test("country and week are rejected for the other charts, which are global and current", async (t) => {
    const { client, mock } = await setupServer(t, ENV, chartsRouter());
    for (const args of [
      { chart: "most_played", country: "DE" },
      { chart: "concurrent_players", week: "2026-03-05" },
    ]) {
      const res = await client.callTool({ name: "get_charts", arguments: args });
      assert.equal(res.isError, true);
    }
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

  test("most_played takes names from the chart in one request and maps last_week_rank 0 to null", async (t) => {
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
    assert.equal(s.entries[2]!.name, null); // Steam sent no item for it
    assert.equal(mock.calls.length, 1);
    const u = decodeURIComponent(mock.calls[0]!.url);
    assert.match(u, /"data_request":\{\}/);
  });

  test("most_played_deck asks for the past week, takes names from the chart and maps -1 to null", async (t) => {
    const { client, mock } = await setupServer(t, ENV, chartsRouter());
    const res = await client.callTool({
      name: "get_charts",
      arguments: { chart: "most_played_deck", limit: 2 },
    });
    const s = res.structuredContent as Out;
    assert.equal(s.chart, "most_played_deck");
    assert.equal(s.as_of, null);
    assert.deepEqual(s.entries[0], {
      rank: 1,
      appid: 2868840,
      name: "Slay the Spire 2",
      store_url: "https://store.steampowered.com/app/2868840",
      last_week_rank: 1,
    });
    assert.equal(s.entries[1]!.last_week_rank, null);
    const u = decodeURIComponent(
      mock.calls.find((c) => c.url.includes("GetMostPlayedSteamDeckGames"))!.url,
    );
    assert.match(u, /"top_played_period":1/);
    // limit goes upstream as count: each entry carries a full store item.
    assert.match(u, /"count":2/);
    assert.ok(!mock.calls.some((c) => c.url.includes("IStoreBrowseService/GetItems")));
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

  test("limit only trims: the cached full chart serves every limit", async (t) => {
    // Neither player chart takes a count upstream, so one cached response
    // backs every limit.
    const { client, mock } = await setupServer(t, ENV, chartsRouter());
    for (const limit of [1, 3]) {
      const res = await client.callTool({
        name: "get_charts",
        arguments: { chart: "most_played", limit },
      });
      assert.equal((res.structuredContent as Out).count, limit);
    }
    assert.equal(mock.calls.length, 1);
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
