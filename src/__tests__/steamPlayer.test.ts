// Integration tests for the key-gated player tools (profile, bans, library,
// achievements, friends, vanity resolution) — mirrors tools/webPlayer.ts. Split
// out of a single steam.test.ts once it grew past 1600 lines; see
// steamStorefront.test.ts (Storefront tools) and steamCatalog.test.ts
// (keyless-capable Web API store tools).
import { describe, test } from "node:test";
import { loadConfig } from "../config.ts";
import assert from "node:assert/strict";
import {
  setupServer,
  jsonResponse,
  htmlResponse,
  recorded,
  assertToolError,
  textOf,
  assertNotShown,
} from "./helpers.ts";
import {
  ENV,
  FRIENDLIST,
  OWNED,
  PLAYERS,
  SCHEMA,
  router,
  getItemsAnswer,
} from "./steamFixtures.ts";
import { FRIENDS_CHECKED_MAX, FRIENDS_MAX } from "../format/web.ts";
import { OWNED_GAMES_LIMIT_MAX } from "../tools/webPlayer.ts";

// Steam answers a raw, non-JSON HTTP 400 (not its usual empty-200 response) for
// some malformed/out-of-range steamids — e.g. the SteamID64 base constant
// (accountid 0), which is 17 digits and passes the tool schema but is never a
// real account. Regression coverage for that raw body leaking to the agent.
test("player tools error clearly without STEAM_API_KEY", async (t) => {
  const { client } = await setupServer(t);
  const res = await client.callTool({
    name: "get_owned_games",
    arguments: { steamid: "76561197960287930" },
  });
  assertToolError(res, /STEAM_API_KEY/);
});

test("the key-gate message only promises a public profile where one is needed", async (t) => {
  // Regression: one blanket message told every key-gated tool's caller to go
  // make the target profile public. Four of them don't care —
  // get_player_summary/get_player_bans read private profiles fine (which is why
  // their found:false says "no such account" instead of offering a privacy
  // hint), resolve_vanity_url resolves a name, and get_game_achievements takes
  // an appid and no profile at all — so that advice sent the caller after a
  // setting that would change nothing about the error they just got.
  const { client } = await setupServer(t);
  const sid = "76561197960287930";
  for (const [name, args] of [
    ["get_player_summary", { steamid: sid }],
    ["get_player_bans", { steamid: sid }],
    ["resolve_vanity_url", { vanity: "gabelogannewell" }],
    ["get_game_achievements", { appid: 620 }],
  ] as const) {
    const res = await client.callTool({ name, arguments: args });
    assertToolError(res, /STEAM_API_KEY/);
    assert.doesNotMatch(textOf(res), /must also be public/, name);
  }
  for (const [name, args] of [
    ["get_owned_games", { steamid: sid }],
    ["get_friend_list", { steamid: sid }],
    ["get_player_achievements", { steamid: sid, appid: 620 }],
  ] as const) {
    const res = await client.callTool({ name, arguments: args });
    assert.match(textOf(res), /must also be public/, name);
  }
});

describe("get_owned_games", () => {
  test("get_owned_games sorts by playtime and converts to hours", async (t) => {
    const { client } = await setupServer(t, ENV, router);
    const res = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as {
      game_count: number;
      games: { name: string; playtime_hours: number }[];
    };
    assert.equal(s.game_count, 2);
    // Portal (1200 min = 20h) sorts before Portal 2 (600 min = 10h).
    assert.equal(s.games[0]!.name, "Portal");
    assert.equal(s.games[0]!.playtime_hours, 20);
  });

  test("get_owned_games reports found:false for a private profile", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetOwnedGames") ? jsonResponse({ response: {} }) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as {
      found: boolean;
      reason: string;
      game_count: number | null;
    };
    assert.equal(s.found, false);
    assert.equal(s.game_count, null);
    assertNotShown(s.reason);
  });

  // Regression: a steamid pasted with surrounding whitespace (e.g. copied from a
  // profile URL or with a trailing newline) is trimmed before validation and
  // before the upstream call — matching the vanity field and the STEAM_ID env
  // var (commit e86eb29) — instead of hard-failing the \d{17} schema.
  test("trims surrounding whitespace from a padded steamid", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    const res = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "  76561197960287930  " },
    });
    assert.equal(res.isError, undefined);
    assert.equal((res.structuredContent as { game_count: number }).game_count, 2);
    assert.ok(
      mock.calls.some((c) => c.url.includes("steamid=76561197960287930") && !c.url.includes("%20")),
    );
  });

  // The \d{17} shape alone isn't enough: an all-zeros id is below the
  // individual-account base (76561197960265728) and can never be a real
  // profile, so it's rejected at the schema boundary, never sent upstream.
  test("rejects a 17-digit steamid below the individual-account base", async (t) => {
    const { client } = await setupServer(t, ENV, router);
    const res = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "00000000000000000" },
    });
    assert.equal(res.isError, true);
  });

  // Regression: the range-check .refine() runs even after the \d{17} .regex()
  // already failed, so a non-digit value (e.g. a vanity name passed by mistake)
  // must not throw a raw "Cannot convert X to a BigInt" — it fails with the
  // actionable message pointing at resolve_vanity_url instead.
  test("rejects a non-digit steamid with the actionable message, not a raw BigInt error", async (t) => {
    const { client } = await setupServer(t, ENV, router);
    const res = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "grinv" },
    });
    assertToolError(res, /resolve_vanity_url/);
    assert.doesNotMatch(textOf(res), /BigInt/i);
  });

  test("get_owned_games: check_appids on a private profile reports unknown, not a false owned:false", async (t) => {
    // Regression: ownership is genuinely unknown when the profile is private —
    // the old behavior claimed owned:false for every checked appid, which
    // misrepresents "can't check" as "doesn't own it".
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetOwnedGames") ? jsonResponse({ response: {} }) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "76561197960287930", check_appids: [620] },
    });
    const s = res.structuredContent as { found: boolean; owns?: unknown };
    assert.equal(s.found, false);
    assert.equal(s.owns, undefined);
  });

  test("get_owned_games: check_appids reliably reports ownership even outside the top-50 cap", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetOwnedGames")
        ? jsonResponse({
            response: {
              game_count: 2,
              games: [
                { appid: 620, name: "Portal 2", playtime_forever: 600 },
                { appid: 400, name: "Portal", playtime_forever: 1200 },
              ],
            },
          })
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "76561197960287930", check_appids: [620, 999] },
    });
    const s = res.structuredContent as {
      owns: { appid: number; owned: boolean; playtime_hours: number | null }[];
    };
    assert.deepEqual(s.owns, [
      { appid: 620, owned: true, playtime_hours: 10 },
      { appid: 999, owned: false, playtime_hours: null },
    ]);
  });

  test("get_owned_games: a repeated check_appids entry gets one owns row", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetOwnedGames")
        ? jsonResponse({
            response: {
              game_count: 1,
              games: [{ appid: 620, name: "Portal 2", playtime_forever: 600 }],
            },
          })
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "76561197960287930", check_appids: [620, 620, 999] },
    });
    const s = res.structuredContent as { owns: { appid: number }[] };
    assert.deepEqual(
      s.owns.map((o) => o.appid),
      [620, 999],
    );
  });

  test(`get_owned_games rejects a limit past ${OWNED_GAMES_LIMIT_MAX} before calling the upstream`, async (t) => {
    // The ceiling is a response-size budget, not an upstream one: measured live,
    // an owned-games row is ~95 chars, so the previous 1000 produced a ~95 KB
    // response — MCP clients reject that outright for exceeding their per-result
    // token limit and the caller gets nothing at all. Asserted against the
    // exported constant, and that nothing reached Steam, so a future raise has
    // to come back through this comment.
    const { client, mock } = await setupServer(t, ENV, router);
    const tooBig = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "76561197960287930", limit: OWNED_GAMES_LIMIT_MAX + 1 },
    });
    assert.equal(tooBig.isError, true);
    const zero = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "76561197960287930", limit: 0 },
    });
    assert.equal(zero.isError, true);
    assert.equal(mock.calls.filter((c) => c.url.includes("GetOwnedGames")).length, 0);

    const ok = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "76561197960287930", limit: OWNED_GAMES_LIMIT_MAX },
    });
    assert.notEqual(ok.isError, true);
  });
});

describe("get_recently_played", () => {
  test("get_recently_played lists games played in the last two weeks", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    const res = await client.callTool({
      name: "get_recently_played",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as {
      found: boolean;
      total: number;
      games: { appid: number; name: string; playtime_hours: number }[];
    };
    assert.equal(s.found, true);
    assert.equal(s.total, 2);
    assert.equal(s.games[0]!.appid, 620);
    assert.equal(s.games[0]!.playtime_hours, 10); // 600 min playtime_forever → 10h
    // Steam sorts and caps the list itself.
    assert.match(mock.calls.find((c) => c.url.includes("GetRecentlyPlayedGames"))!.url, /count=50/);
  });

  test("get_recently_played reports found:false for a private profile", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetRecentlyPlayedGames") ? jsonResponse({ response: {} }) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_recently_played",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; total: number; games: unknown[] };
    assert.equal(s.found, false);
    assert.equal(s.total, 0);
    assert.deepEqual(s.games, []);
  });

  test("get_recently_played reports found:true with an empty list for a public profile with no recent activity (distinct from private)", async (t) => {
    // GetRecentlyPlayedGames' own keyless-of-privacy shape is {total_count:0}
    // with no `games` array at all — distinct from a private profile's empty
    // `{response:{}}` (no total_count key either).
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetRecentlyPlayedGames")
        ? jsonResponse({ response: { total_count: 0 } })
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_recently_played",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; total: number; games: unknown[] };
    assert.equal(s.found, true);
    assert.equal(s.total, 0);
    assert.deepEqual(s.games, []);
  });
});

describe("get_recommended_games", () => {
  // tagid 1 = Roguelike, tagid 2 = Horror. The player owns appid 10 (200min,
  // Roguelike), appid 20 (0min, Horror — ignored, no playtime), and appid 60,
  // a free-to-play Roguelike Steam only returns when include_played_free_games
  // is set — regression coverage for a bug where an owned F2P game was missing
  // from the exclusion set (and got recommended right back).
  function recoRouter(url: string) {
    if (url.includes("GetOwnedGames")) {
      const games = [
        { appid: 10, playtime_forever: 200 },
        { appid: 20, playtime_forever: 0 },
      ];
      if (url.includes("include_played_free_games=true"))
        games.push({ appid: 60, playtime_forever: 0 });
      return jsonResponse({ response: { game_count: games.length, games } });
    }
    if (url.includes("GetTagList")) {
      return jsonResponse({
        response: {
          tags: [
            { tagid: 1, name: "Roguelike" },
            { tagid: 2, name: "Horror" },
            { tagid: 3, name: "Souls-like" },
          ],
        },
      });
    }
    if (url.includes("IStoreBrowseService/GetItems")) {
      return jsonResponse(
        getItemsAnswer(url, {
          response: {
            store_items: [
              { appid: 10, visible: true, tags: [{ tagid: 1, weight: 900 }] },
              { appid: 20, visible: true, tags: [{ tagid: 2, weight: 900 }] },
            ],
          },
        }),
      );
    }
    if (url.includes("IStoreQueryService/Query")) {
      return jsonResponse({
        response: {
          metadata: { total_matching_records: 3 },
          store_items: [
            {
              appid: 10,
              name: "Owned Roguelike",
              visible: true,
              tags: [{ tagid: 1, weight: 900 }],
              reviews: { summary_filtered: { percent_positive: 90 } },
            },
            {
              appid: 30,
              name: "New Roguelike",
              visible: true,
              tags: [{ tagid: 1, weight: 900 }],
              reviews: { summary_filtered: { percent_positive: 95 } },
              best_purchase_option: { formatted_final_price: "$9.99" },
            },
            { appid: 40, name: "Horror Only", visible: true, tags: [{ tagid: 2, weight: 900 }] },
            {
              appid: 60,
              name: "Owned F2P Roguelike",
              visible: true,
              tags: [{ tagid: 1, weight: 900 }],
              reviews: { summary_filtered: { percent_positive: 99 } },
            },
          ],
        },
      });
    }
    return jsonResponse({});
  }

  test("get_recommended_games ranks by playtime-weighted tags, excluding owned games", async (t) => {
    const { client } = await setupServer(t, ENV, recoRouter);
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as {
      found: boolean;
      based_on_tags: string[];
      count: number;
      recommendations: { appid: number; name: string; matched_tags: string[] }[];
    };
    assert.equal(s.found, true);
    assert.deepEqual(s.based_on_tags, ["Roguelike"]); // Horror had 0 playtime weight
    // appid 10 is owned (excluded despite matching); appid 40 has no tag
    // overlap (dropped); appid 60 is an owned F2P game (excluded — regression
    // check for GetOwnedGames needing include_played_free_games) — only the
    // unowned Roguelike remains.
    assert.deepEqual(
      s.recommendations.map((r) => r.appid),
      [30],
    );
    assert.deepEqual(s.recommendations[0]!.matched_tags, ["Roguelike"]);
  });

  test("get_recommended_games: `limit` caps the returned picks, and the old `count` name is rejected loudly", async (t) => {
    // Renamed count → limit so the "how many to RETURN" parameter is spelled the
    // same as get_game_news'/get_game_reviews'. discover_games keeps `count`
    // because it means something else there (entries to SCAN). The input schemas
    // are strictObject, so a caller still passing `count` gets a clear
    // Unrecognized-key error rather than silently falling back to the default.
    const { client } = await setupServer(t, ENV, recoRouter);
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930", limit: 1 },
    });
    const s = res.structuredContent as { count: number; recommendations: unknown[] };
    assert.notEqual(res.isError, true);
    assert.equal(s.recommendations.length, 1);
    assert.equal(s.count, 1);

    const old = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930", count: 1 },
    });
    assertToolError(old, /unrecognized key/i);
  });

  test("get_recommended_games: min_discount is forwarded as a server-side price filter", async (t) => {
    const { client, mock } = await setupServer(t, ENV, recoRouter);
    await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930", min_discount: 30 },
    });
    const queryCall = mock.calls.find((c) => c.url.includes("IStoreQueryService/Query"))!;
    const input = JSON.parse(new URL(queryCall.url).searchParams.get("input_json")!);
    assert.equal(input.query.filters.price_filters.min_discount_percent, 30);
  });

  test("get_recommended_games: the pool is games-only, favorite-tagged and excludes exclude_tags server-side", async (t) => {
    const { client, mock } = await setupServer(t, ENV, recoRouter);
    await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930", exclude_tags: ["souls-like"] },
    });
    const queryCall = mock.calls.find((c) => c.url.includes("IStoreQueryService/Query"))!;
    const input = JSON.parse(new URL(queryCall.url).searchParams.get("input_json")!);
    assert.deepEqual(input.query.filters.type_filters, { include_games: true });
    assert.deepEqual(input.query.filters.tagids_exclude, [3]);
    // The pool is narrowed to games carrying ANY favorite tag: one group, ORed.
    const groups = input.query.filters.tagids_must_match as { tagids: number[] }[];
    assert.equal(groups.length, 1);
    assert.ok(groups[0]!.tagids.length > 0);
  });

  test("get_recommended_games: an exclude tag Steam doesn't have is refused, naming it", async (t) => {
    const { client, mock } = await setupServer(t, ENV, recoRouter);
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930", exclude_tags: ["souls-like", "Not A Tag"] },
    });
    assertToolError(res, /Not a Steam tag in english: "Not A Tag"\./);
    assert.ok(!mock.calls.some((c) => c.url.includes("IStoreQueryService/Query")));
  });

  // The dictionary failing is Steam's, not the input's: a hidden library's
  // own verdict still comes first.
  // Deterministic: the library's failure is a value, so the input's error is
  // the one reported, whichever answer lands first.
  test("get_recommended_games: an unknown exclude tag wins over a failing library", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) =>
      url.includes("GetOwnedGames") ? jsonResponse({}, { status: 503 }) : recoRouter(url),
    );
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930", exclude_tags: ["Not A Tag"] },
    });
    assertToolError(res, /Not a Steam tag in english: "Not A Tag"\./);
  });

  test("get_recommended_games: a hidden library is found:false even with the dictionary down", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetTagList")) return jsonResponse({}, { status: 503 });
      if (url.includes("GetOwnedGames")) return jsonResponse({ response: {} });
      return recoRouter(url);
    });
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930" },
    });
    assert.equal((res.structuredContent as { found: boolean }).found, false);
  });

  test("get_recommended_games: a failed dictionary says recommendations need it, not `tags`", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) =>
      url.includes("GetTagList") ? jsonResponse({}, { status: 500 }) : recoRouter(url),
    );
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930", exclude_tags: ["RPG"] },
    });
    assertToolError(res, /recommendations can't be computed/);
    assert.doesNotMatch((res.content as { text: string }[])[0]!.text, /`tags`/);
  });

  test("get_recommended_games: an unknown exclude tag is refused even for a hidden library", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetOwnedGames") ? jsonResponse({ response: {} }) : recoRouter(url),
    );
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930", exclude_tags: ["Not A Tag"] },
    });
    assertToolError(res, /Not a Steam tag in english: "Not A Tag"\./);
  });

  // recoRouter elsewhere: the dictionary is read alongside the library, and a
  // real Steam always has one.
  test("get_recommended_games reports found:false for a private profile", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetOwnedGames") ? jsonResponse({ response: {} }) : recoRouter(url),
    );
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assertNotShown(s.reason);
  });

  test("get_recommended_games reports found:false for a PUBLIC profile with zero games (distinct from private)", async (t) => {
    // web.ts's own private-profile check (games/game_count both undefined)
    // never fires here — this is storeService.getRecommendedGames' OWN
    // "ownedGames.length === 0" branch, reached only once the profile is
    // confirmed public but genuinely empty.
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetOwnedGames")
        ? jsonResponse({ response: { game_count: 0, games: [] } })
        : recoRouter(url),
    );
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /no games to base recommendations/i);
    assert.doesNotMatch(s.reason, /private/i);
  });

  test("get_recommended_games reports found:false when owned games resolve to no tags at all", async (t) => {
    // Distinct from the empty-library branch: the player owns played games,
    // but none of their tags resolve (e.g. GetItems returns items with no
    // tags for those appids) — tagWeights ends up empty.
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("GetOwnedGames")) {
        return jsonResponse({
          response: { game_count: 1, games: [{ appid: 10, playtime_forever: 200 }] },
        });
      }
      if (url.includes("GetTagList")) {
        return jsonResponse({ response: { tags: [{ tagid: 1, name: "Roguelike" }] } });
      }
      if (url.includes("IStoreBrowseService/GetItems")) {
        // no tags
        return jsonResponse(
          getItemsAnswer(url, { response: { store_items: [{ appid: 10, visible: true }] } }),
        );
      }
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /resolvable tags/i);
  });

  test("get_recommended_games errors clearly when the tag dictionary is unavailable", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetTagList")) return jsonResponse({}, { status: 500 });
      return recoRouter(url);
    });
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930" },
    });
    assertToolError(res, /tag dictionary/i);
  });
});

describe("get_player_achievements", () => {
  test("get_player_achievements computes completion", async (t) => {
    const { client } = await setupServer(t, ENV, router);
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    const s = res.structuredContent as { total: number; unlocked: number; completion_pct: number };
    assert.equal(s.total, 2);
    assert.equal(s.unlocked, 1);
    assert.equal(s.completion_pct, 50);
  });

  test("get_player_achievements forwards a per-call language override", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620, language: "russian" },
    });
    const u = mock.calls.find((c) => c.url.includes("GetPlayerAchievements"))!.url;
    assert.match(u, /l=russian/);
  });

  test("get_player_achievements: a game the player doesn't own is Steam's same 403 — no cause is picked", async (t) => {
    // Recorded on a public profile without the game: Steam's body says
    // "Profile is not public", which is exactly the guess not to repeat.
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetPlayerAchievements")
        ? recorded("GetPlayerAchievements/game-not-owned")
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 1245620 },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assertNotShown(s.reason);
    assert.match(s.reason, /check_appids shows whether they own the game/);
  });

  test("get_player_achievements: private game details (403) → not shown, no cause picked", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetPlayerAchievements")
        ? recorded("GetPlayerAchievements/private-game-details")
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assertNotShown(s.reason);
  });

  // A bad/revoked key gets Steam's "verify your key=" page on every key-gated
  // endpoint — a 401 on some, a 403 on others (recorded per endpoint, never
  // guessed: a fixture once said 401 for all of IPlayerService, and only
  // GetOwnedGames is). It must surface as invalid_key, never as "private".
  for (const [tool, endpoint, args] of [
    ["get_player_achievements", "GetPlayerAchievements", { appid: 620 }],
    ["get_friend_list", "GetFriendList", {}],
    ["get_owned_games", "GetOwnedGames", {}],
    ["get_recently_played", "GetRecentlyPlayedGames", {}],
    ["get_player_summary", "GetPlayerSummaries", {}],
    ["find_friends_who_own", "GetFriendList", { appids: [620] }],
  ] as const) {
    test(`${tool}: a bad key reports invalid_key, not a private profile`, async (t) => {
      const { client } = await setupServer(t, ENV, (url) =>
        url.includes(endpoint) ? recorded(`${endpoint}/bad-key`) : jsonResponse({}),
      );
      const res = await client.callTool({
        name: tool,
        arguments: { steamid: "76561197960287930", ...args },
      });
      assert.equal(res.isError, true);
      const text = (res.content as { text: string }[])[0]!.text;
      assert.match(text, /^Steam rejected the configured STEAM_API_KEY/);
      assert.doesNotMatch(text, /private/i);
    });
  }

  test("get_game_achievements: a revoked key isn't papered over with a cached schema", async (t) => {
    let revoked = false;
    const { client } = await setupServer(
      t,
      { ...ENV, CACHE_TTL_MS: "1", HTTP_RETRIES: "0" },
      (url) => {
        if (revoked && url.includes("GetSchemaForGame"))
          return recorded("GetSchemaForGame/bad-key");
        return router(url);
      },
    );
    const first = await client.callTool({
      name: "get_game_achievements",
      arguments: { appid: 620 },
    });
    assert.equal(first.isError, undefined);
    await new Promise((r) => setTimeout(r, 5)); // let the 1 ms entry go stale
    revoked = true;
    const res = await client.callTool({ name: "get_game_achievements", arguments: { appid: 620 } });
    assertToolError(res, /^Steam rejected the configured STEAM_API_KEY/);
  });

  test("get_game_achievements: no schema for the appid is an error, never '0 achievements'", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetSchemaForGame") ? recorded("GetSchemaForGame/no-app") : router(url),
    );
    const res = await client.callTool({
      name: "get_game_achievements",
      arguments: { appid: 99999999 },
    });
    assertToolError(res, /no achievement schema for this appid; get_game shows/);
  });

  test("get_game_achievements: a bad key on the schema call isn't read as 'no achievements'", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetSchemaForGame")) return recorded("GetSchemaForGame/bad-key");
      // The keyless rarity call fails appid-specifically too, which used to
      // make the pair read as "this game has no achievement schema".
      if (url.includes("GetGlobalAchievementPercentages"))
        return recorded("GetGlobalAchievementPercentagesForApp/schema-less-dlc");
      return jsonResponse({});
    });
    const res = await client.callTool({ name: "get_game_achievements", arguments: { appid: 620 } });
    assertToolError(res, /^Steam rejected the configured STEAM_API_KEY/);
  });

  // A 200 with success:false is decided by the schema (a fact), never by
  // Steam's error wording (unprobed text that once short-circuited it).
  test("get_player_achievements: success:false's error text doesn't decide, the schema does", async (t) => {
    const { client, mock } = await setupServer(t, ENV, (url) => {
      if (url.includes("GetPlayerAchievements"))
        return jsonResponse({ playerstats: { success: false, error: "Profile is not public" } });
      if (url.includes("GetSchemaForGame"))
        return jsonResponse({ game: { availableGameStats: { achievements: [] } } });
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.equal(s.reason, "This game has no achievements.");
    assert.ok(mock.calls.some((c) => c.url.includes("GetSchemaForGame")));
  });

  test("get_player_achievements: success:false + game has no achievements", async (t) => {
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("GetPlayerAchievements"))
        return jsonResponse({ playerstats: { success: false } });
      if (url.includes("GetSchemaForGame"))
        return jsonResponse({ game: { availableGameStats: { achievements: [] } } });
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /no achievements/i);
  });

  test("get_player_achievements: success:false but game HAS achievements → hidden/private", async (t) => {
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("GetPlayerAchievements"))
        return jsonResponse({ playerstats: { success: false } });
      if (url.includes("GetSchemaForGame")) return jsonResponse(SCHEMA); // 2 achievements
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assertNotShown(s.reason);
  });

  // A genuine upstream failure (not a private/no-stats disambiguation signal)
  // must surface as a real tool error, not get silently swallowed into
  // found:false — only forbidden/unauthorized/bad_request/not_found are
  // treated as "explain, don't fail" (see #getPlayerAchievements' catch).
  test("get_player_achievements: a genuine 500 propagates as a tool error, not found:false", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) =>
      url.includes("GetPlayerAchievements") ? jsonResponse({}, { status: 500 }) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    assertToolError(res, /5xx|retry later/i);
  });

  // #explainNoPlayerAchievements' own fallback: the disambiguating
  // GetSchemaForGame lookup can itself fail. That must still degrade to a
  // reason string, never throw/crash the tool.
  test("get_player_achievements: a bad key on the fallback schema lookup isn't 'no achievements'", async (t) => {
    // Only Steam's appid-level answer may become that verdict; anything else
    // (here invalid_key) is not an answer about the game.
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetPlayerAchievements"))
        return jsonResponse({ playerstats: { success: false } });
      if (url.includes("GetSchemaForGame")) return recorded("GetSchemaForGame/bad-key");
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    assertToolError(res, /^Steam rejected the configured STEAM_API_KEY/);
  });

  test("get_player_achievements: an unusable schema answer is retryable, not a 'no achievements' verdict", async (t) => {
    // Transience is read from the error's own `retryable` (set where it's
    // classified), not a separate code list — bad_response was missing from
    // that list, so a garbled schema answer read as a definitive verdict.
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetPlayerAchievements"))
        return jsonResponse({ playerstats: { success: false } });
      if (url.includes("GetSchemaForGame"))
        return htmlResponse("<html>garbled</html>", { status: 200 });
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    assertToolError(res, /unusable response.*retry/i);
  });

  test("get_player_achievements: Steam's own error text classifies but never reaches the agent", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetPlayerAchievements"))
        return jsonResponse({ playerstats: { success: false, error: "Steam's own words" } });
      if (url.includes("GetSchemaForGame")) return recorded("GetSchemaForGame/no-app");
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /no achievement schema/);
    assert.doesNotMatch(s.reason, /Steam's own words/);
  });

  test("get_player_achievements: a transient schema-lookup failure is retryable, not a verdict", async (t) => {
    // The disambiguating GetSchemaForGame call used to be wrapped in a bare
    // catch, so a 5xx on it turned into a definitive "Achievements unavailable."
    // — telling the agent to stop asking about a game that may well have them.
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetPlayerAchievements"))
        return jsonResponse({ playerstats: { success: false } });
      if (url.includes("GetSchemaForGame")) return jsonResponse({}, { status: 500 });
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    assertToolError(res, /5xx|retry/i);
  });

  test("get_player_achievements: a non-transient schema-lookup failure still gives the fallback reason", async (t) => {
    // The other half of the same branch: Steam's own "no such app" answer for
    // the schema (a 400, probed live) is a verdict, so a found:false answer.
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetPlayerAchievements"))
        return jsonResponse({ playerstats: { success: false } });
      if (url.includes("GetSchemaForGame")) return recorded("GetSchemaForGame/no-app");
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /no achievement schema/);
  });
});

describe("get_friend_list", () => {
  test("get_friend_list enriches only the friends it will return, not the whole list", async (t) => {
    // GetPlayerSummaries is chunked at 100 ids; the summarizer then sorts by
    // friend_since and keeps FRIENDS_MAX. Enriching all 250 cost 3 round-trips
    // to fill a 100-entry list and threw 2 of them away.
    const friends = Array.from({ length: 250 }, (_, i) => ({
      steamid: `765611979602${String(i + 1000).padStart(5, "0")}`,
      relationship: "friend",
      friend_since: 1600000000 + i,
    }));
    const { client, mock } = await setupServer(t, ENV, (url) => {
      if (url.includes("GetFriendList")) return jsonResponse({ friendslist: { friends } });
      if (url.includes("GetPlayerSummaries")) return jsonResponse(PLAYERS);
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_friend_list",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { total: number; returned: number };
    assert.equal(s.total, 250);
    assert.equal(s.returned, FRIENDS_MAX);
    const summaryCalls = mock.calls.filter((c) => c.url.includes("GetPlayerSummaries"));
    assert.equal(summaryCalls.length, 1);
    // And it's the newest 100 that got enriched, matching the summarizer's sort.
    const asked = new URL(summaryCalls[0]!.url).searchParams.get("steamids")!.split(",");
    assert.equal(asked.length, FRIENDS_MAX);
    assert.equal(asked[0], friends.at(-1)!.steamid);
  });

  test("get_friend_list merges names and sorts most-recent-friend-first", async (t) => {
    const { client } = await setupServer(t, ENV, router);
    const res = await client.callTool({
      name: "get_friend_list",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as {
      found: boolean;
      total: number;
      friends: { steamid: string; name: string; state: string }[];
    };
    assert.equal(s.found, true);
    assert.equal(s.total, 2);
    // 76561197960287931 has the later friend_since, so it sorts first.
    assert.equal(s.friends[0]!.steamid, "76561197960287931");
    assert.equal(s.friends[0]!.name, "Two Socks");
    assert.equal(s.friends[1]!.name, "Rabscuttle");
    assert.equal(s.friends[1]!.state, "online");
  });

  test("get_friend_list reports found:false for a private friends list (401)", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetFriendList") ? recorded("GetFriendList/friends-only") : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_friend_list",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /friends list/i);
  });

  test("get_friend_list: a syntactically valid but nonexistent steamid reports found:false, not a raw 404", async (t) => {
    // Confirmed live: Steam answers a plain 404 ("No matching resource was
    // found") for a well-formed SteamID64 that isn't a real account — distinct
    // from the accountid-0 case above (a raw 400), but every sibling tool
    // (get_player_summary, get_owned_games, ...) already degrades this same id
    // to found:false, so get_friend_list should too instead of leaking the 404.
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetFriendList") ? recorded("GetFriendList/no-account") : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_friend_list",
      arguments: { steamid: "76561199999999999" },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /friends list/i);
  });

  // The answer is the method's JSON {} with that status; the same status as a
  // gateway's HTML page (a retired route, a proxy, an edge block) says
  // nothing about the player.
  test("get_friend_list: a 404 that is a gateway page, not Steam's {}, is an error", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetFriendList")
        ? htmlResponse("<html>Not Found</html>", { status: 404 })
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_friend_list",
      arguments: { steamid: "76561199999999999" },
    });
    assertToolError(res, /No matching resource was found/);
  });

  test("get_friend_list: a genuine 500 propagates as a tool error, not found:false", async (t) => {
    // #friendsRaw only swallows 403/401 into null (→ found:false); every
    // other failure code must still surface as a real error.
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) =>
      url.includes("GetFriendList") ? jsonResponse({}, { status: 500 }) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_friend_list",
      arguments: { steamid: "76561197960287930" },
    });
    assertToolError(res, /5xx|retry later/i);
  });
});

describe("find_friends_who_own", () => {
  test("find_friends_who_own checks each friend's FULL library and separates private ones", async (t) => {
    const { client, mock } = await setupServer(t, ENV, (url) => {
      if (url.includes("GetFriendList")) return jsonResponse(FRIENDLIST);
      if (url.includes("GetPlayerSummaries")) return jsonResponse(PLAYERS);
      if (url.includes("GetOwnedGames")) {
        // 76561197960287931's library is private; the other owns 620 + 400.
        if (url.includes("steamid=76561197960287931")) return jsonResponse({ response: {} });
        return jsonResponse(OWNED);
      }
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620, 999], steamid: "76561197960287930" },
    });
    const s = res.structuredContent as {
      total_friends: number;
      matches: {
        appid: number;
        owners: { steamid: string; name: string | null; playtime_hours: number | null }[];
      }[];
      not_shown_friends: { steamid: string; name: string | null }[];
    };
    assert.equal(s.total_friends, 2);
    const m620 = s.matches.find((m) => m.appid === 620)!;
    assert.equal(m620.owners.length, 1);
    assert.equal(m620.owners[0]!.name, "Rabscuttle");
    // OWNED gives appid 620 a playtime_forever of 600 minutes = 10h.
    assert.equal(m620.owners[0]!.playtime_hours, 10);
    const m999 = s.matches.find((m) => m.appid === 999)!;
    assert.equal(m999.owners.length, 0);
    // Each friend's lookup asks Steam for just the requested appids, not the
    // whole library.
    const lookup = decodeURIComponent(mock.calls.find((c) => c.url.includes("GetOwnedGames"))!.url);
    assert.match(lookup, /appids_filter\[0\]=620&appids_filter\[1\]=999/);
    assert.equal(s.not_shown_friends.length, 1);
    assert.equal(s.not_shown_friends[0]!.steamid, "76561197960287931");
  });

  // Promise.allSettled coverage: one friend's own GetOwnedGames genuinely
  // failing (rate-limited/network/5xx, not the empty-response "private"
  // shape) must not sink everyone else's results.
  test("one friend's GetOwnedGames failure doesn't sink the whole call — that friend lands in unavailable_friends", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetFriendList")) return jsonResponse(FRIENDLIST);
      if (url.includes("GetPlayerSummaries")) return jsonResponse(PLAYERS);
      if (url.includes("GetOwnedGames")) {
        // 76561197960287931's own library lookup genuinely fails; the other
        // friend's still succeeds.
        if (url.includes("steamid=76561197960287931")) {
          return jsonResponse({ error: "server exploded" }, { status: 500 });
        }
        return jsonResponse(OWNED);
      }
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620], steamid: "76561197960287930" },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as {
      total_friends: number;
      matches: { appid: number; owners: { steamid: string; playtime_hours: number | null }[] }[];
      not_shown_friends: { steamid: string }[];
      unavailable_friends: { steamid: string; reason: string }[];
    };
    assert.equal(s.total_friends, 2);
    // The healthy friend's ownership still comes through untouched.
    const m620 = s.matches.find((m) => m.appid === 620)!;
    assert.equal(m620.owners.length, 1);
    assert.equal(m620.owners[0]!.steamid, "76561197960287930");
    assert.equal(m620.owners[0]!.playtime_hours, 10);
    // The failing friend is unavailable, NOT counted as private.
    assert.equal(s.not_shown_friends.length, 0);
    assert.equal(s.unavailable_friends.length, 1);
    assert.equal(s.unavailable_friends[0]!.steamid, "76561197960287931");
    assert.match(s.unavailable_friends[0]!.reason, /5xx|500|retry later/i);
    // The raw upstream error body must never reach this field verbatim — it's
    // translated the same way a top-level tool failure is (toProblem()), not
    // embedded as-is (which could otherwise leak raw HTML/error-page text).
    assert.doesNotMatch(s.unavailable_friends[0]!.reason, /server exploded/);
  });

  test("friends failing for different reasons get one note per reason, not the first one's", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetOwnedGames")) {
        if (url.includes("steamid=76561197960287930")) return jsonResponse({}, { status: 503 });
        if (url.includes("steamid=76561197960287931")) return jsonResponse({}, { status: 429 });
      }
      return router(url);
    });
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620], steamid: "76561197960287930" },
    });
    const notes = (res.structuredContent as { notes: string[] }).notes;
    assert.equal(notes.length, 2);
    assert.ok(notes.some((n) => /^Game ownership of 1 friends .*\(503\)/.test(n)));
    assert.ok(notes.some((n) => /^Game ownership of 1 friends .*\(429\)/.test(n)));
  });

  test("a GetPlayerSummaries chunk failure (150-friend list, 2 chunks) doesn't sink the whole call", async (t) => {
    // #playerSummaries chunks at 100 ids/call, and find_friends_who_own enriches
    // the FULL friend list (unlike get_friend_list, which now enriches only the
    // 100 it returns and so never spans two chunks). Fail only the second chunk:
    // the first 100 friends' names must still come through, not a hard error.
    const manyFriends = Array.from({ length: 150 }, (_, i) => ({
      steamid: `765611979602${String(87930 + i).padStart(5, "0")}`,
      relationship: "friend",
      friend_since: 1600000000 + i,
    }));
    // Friends are looked up most-recently-added first (the same order
    // get_friend_list returns), NOT in Steam's raw payload order, so the chunk a
    // given friend lands in follows from that sort — derive the probes from it
    // rather than from the fixture's own indices.
    const enrichOrder = manyFriends.toSorted((a, b) => b.friend_since - a.friend_since);
    const chunk2Marker = enrichOrder[100]!.steamid; // appears only in the 2nd chunk
    const inChunk1 = enrichOrder[10]!.steamid;
    const inChunk2 = enrichOrder[120]!.steamid;
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetFriendList"))
        return jsonResponse({ friendslist: { friends: manyFriends } });
      if (url.includes("GetPlayerSummaries")) {
        if (url.includes(chunk2Marker)) return jsonResponse({}, { status: 500 });
        return jsonResponse({
          response: {
            players: manyFriends
              .filter((f) => url.includes(f.steamid))
              .map((f) => ({
                steamid: f.steamid,
                personaname: `Friend ${f.steamid}`,
                communityvisibilitystate: 3,
              })),
          },
        });
      }
      if (url.includes("GetOwnedGames")) {
        // Only these two own anything, so the owners list stays well under
        // FRIENDS_WHO_OWN_MAX and both survive to be asserted on — one from each
        // side of the enrichment chunk boundary.
        const owns = [inChunk1, inChunk2].some((id) => url.includes(id));
        return jsonResponse(owns ? OWNED : { response: { game_count: 0, games: [] } });
      }
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620], steamid: "76561197960287930" },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as {
      total_friends: number;
      matches: { appid: number; owners: { steamid: string; name: string | null }[] }[];
    };
    assert.equal(s.total_friends, 150);
    assert.equal(s.matches[0]!.owners.length, 2);
    // One probe came from the chunk that succeeded, the other from the one that
    // failed — the latter degrades to name:null rather than blanking everyone.
    const byId = new Map(s.matches[0]!.owners.map((o) => [o.steamid, o.name]));
    assert.equal(byId.get(inChunk1), `Friend ${inChunk1}`);
    assert.equal(byId.get(inChunk2), null);
  });

  test("find_friends_who_own counts each owner once when an appid is repeated", async (t) => {
    // [620, 620] used to give two identical matches, each listing every owner twice.
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("GetFriendList")) return jsonResponse(FRIENDLIST);
      if (url.includes("GetPlayerSummaries")) return jsonResponse(PLAYERS);
      if (url.includes("GetOwnedGames")) return jsonResponse(OWNED);
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620, 620], steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { matches: { appid: number; owners: unknown[] }[] };
    assert.equal(s.matches.length, 1);
    assert.equal(s.matches[0]!.owners.length, 2);
  });

  test("find_friends_who_own caps how many friends it looks up, and says how many that was", async (t) => {
    // Measured live: one GetOwnedGames call per friend means a 634-friend account
    // runs past the 60s default request timeout an MCP client gives up at, so the
    // whole call fails. Bounded to FRIENDS_CHECKED_MAX, with friends_checked
    // reporting the truth so an unchecked friend never reads as a non-owner.
    const friends = Array.from({ length: FRIENDS_CHECKED_MAX + 75 }, (_, i) => ({
      steamid: `7656119796${String(i + 1000000).padStart(7, "0")}`,
      relationship: "friend",
      friend_since: 1600000000 + i,
    }));
    const { client, mock } = await setupServer(t, ENV, (url) => {
      if (url.includes("GetFriendList")) return jsonResponse({ friendslist: { friends } });
      if (url.includes("GetPlayerSummaries")) return jsonResponse(PLAYERS);
      if (url.includes("GetOwnedGames")) return jsonResponse(OWNED);
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620], steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { total_friends: number; friends_checked: number };
    assert.notEqual(res.isError, true);
    assert.equal(s.total_friends, FRIENDS_CHECKED_MAX + 75);
    assert.equal(s.friends_checked, FRIENDS_CHECKED_MAX);
    // And it really only paid for the friends it checked.
    assert.equal(
      mock.calls.filter((c) => c.url.includes("GetOwnedGames")).length,
      FRIENDS_CHECKED_MAX,
    );
  });

  test("find_friends_who_own reports friends_checked == total_friends on a normal-sized list", async (t) => {
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("GetFriendList")) return jsonResponse(FRIENDLIST);
      if (url.includes("GetPlayerSummaries")) return jsonResponse(PLAYERS);
      if (url.includes("GetOwnedGames")) return jsonResponse(OWNED);
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620], steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { total_friends: number; friends_checked: number };
    assert.equal(s.friends_checked, s.total_friends);
  });

  test("find_friends_who_own bounds its per-friend fan-out but still checks every friend", async (t) => {
    // `ids` is the full, uncapped friend list (FRIENDS_WHO_OWN_MAX caps only the
    // output), so a plain allSettled over it fired one simultaneous request per
    // friend — a large account rate-limited itself and its own allSettled then
    // reported most friends as unavailable.
    const friends = Array.from({ length: 45 }, (_, i) => ({
      steamid: `7656119796028${String(i + 10).padStart(4, "0")}`,
      relationship: "friend",
      friend_since: 1600000000 + i,
    }));
    let inFlight = 0;
    let peak = 0;
    const { client, mock } = await setupServer(t, ENV, async (url) => {
      if (url.includes("GetFriendList")) return jsonResponse({ friendslist: { friends } });
      if (url.includes("GetPlayerSummaries")) return jsonResponse(PLAYERS);
      if (url.includes("GetOwnedGames")) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
        return jsonResponse(OWNED);
      }
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620], steamid: "76561197960287930" },
    });
    assert.notEqual(res.isError, true);
    const owned = mock.calls.filter((c) => c.url.includes("GetOwnedGames"));
    // 45 is under FRIENDS_CHECKED_MAX, so every friend is still checked here — the
    // separate cap test above covers the truncating case.
    assert.equal(owned.length, 45);
    assert.ok(peak <= 10, `expected at most 10 concurrent lookups, saw ${peak}`);
    assert.ok(peak > 1, "the fan-out should still be concurrent, not serial");
  });

  test("find_friends_who_own reports found:false for a private friends list (401)", async (t) => {
    // A friends-only list is a 401 (probed live); a 403 there is the bad-key page.
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetFriendList") ? recorded("GetFriendList/friends-only") : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620], steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /friends list/i);
  });

  // A public-but-empty friends list is distinct from a private one: it's a
  // real, successful zero-friends result, not an error/found:false.
  test("find_friends_who_own handles a public but empty friends list without crashing", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetFriendList")
        ? jsonResponse({ friendslist: { friends: [] } })
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620, 999], steamid: "76561197960287930" },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as {
      total_friends: number;
      matches: { appid: number; owners: unknown[] }[];
      not_shown_friends: unknown[];
    };
    assert.equal(s.total_friends, 0);
    assert.equal(s.matches.length, 2); // both requested appids still reported, just with no owners
    assert.ok(s.matches.every((m) => m.owners.length === 0));
    assert.equal(s.not_shown_friends.length, 0);
  });

  // Regression: without include_played_free_games, Steam omits a played
  // free-to-play game from a friend's GetOwnedGames entirely — an owning
  // friend would then be silently missing from `owners` (not even landing
  // in not_shown_friends/unavailable_friends), contradicting "checks each
  // friend's FULL library".
  test("find_friends_who_own finds an owner of a free-to-play game (needs include_played_free_games)", async (t) => {
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("GetFriendList")) return jsonResponse(FRIENDLIST);
      if (url.includes("GetPlayerSummaries")) return jsonResponse(PLAYERS);
      if (url.includes("GetOwnedGames")) {
        if (!url.includes("include_played_free_games=true")) return jsonResponse({ response: {} });
        return jsonResponse({
          response: { game_count: 1, games: [{ appid: 570, playtime_forever: 120 }] },
        });
      }
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [570], steamid: "76561197960287930" },
    });
    const s = res.structuredContent as {
      matches: { appid: number; owners: { steamid: string }[] }[];
      not_shown_friends: unknown[];
    };
    const m570 = s.matches.find((m) => m.appid === 570)!;
    assert.equal(m570.owners.length, 2);
    assert.equal(s.not_shown_friends.length, 0);
  });
});

describe("compare_players", () => {
  test("compare_players finds shared games with each player's own playtime, sorted by combined playtime", async (t) => {
    const { client } = await setupServer(t, ENV, (url) => {
      if (!url.includes("GetOwnedGames")) return jsonResponse({});
      if (url.includes("steamid=76561197960287931")) {
        return jsonResponse({
          response: {
            game_count: 3,
            games: [
              { appid: 620, name: "Portal 2", playtime_forever: 300 },
              { appid: 400, name: "Portal", playtime_forever: 50 },
              { appid: 111, name: "OnlyB", playtime_forever: 10 },
            ],
          },
        });
      }
      return jsonResponse({
        response: {
          game_count: 3,
          games: [
            { appid: 620, name: "Portal 2", playtime_forever: 600 },
            { appid: 400, name: "Portal", playtime_forever: 1200 },
            { appid: 999, name: "OnlyA", playtime_forever: 100 },
          ],
        },
      });
    });
    const res = await client.callTool({
      name: "compare_players",
      arguments: { steamid: "76561197960287930", other_steamid: "76561197960287931" },
    });
    const s = res.structuredContent as {
      found: boolean;
      shared_count: number;
      games: { appid: number; name: string; playtime_hours_a: number; playtime_hours_b: number }[];
    };
    assert.equal(s.found, true);
    assert.equal(s.shared_count, 2);
    // Portal (1200+50=1250 combined) sorts before Portal 2 (600+300=900).
    assert.equal(s.games[0]!.appid, 400);
    assert.equal(s.games[0]!.playtime_hours_a, 20);
    assert.equal(s.games[0]!.playtime_hours_b, 0.8);
    assert.equal(s.games[1]!.appid, 620);
  });

  test("compare_players reports found:false when either profile is private", async (t) => {
    const { client } = await setupServer(t, ENV, (url) => {
      if (!url.includes("GetOwnedGames")) return jsonResponse({});
      if (url.includes("steamid=76561197960287931")) return jsonResponse({ response: {} });
      return jsonResponse(OWNED);
    });
    const res = await client.callTool({
      name: "compare_players",
      arguments: { steamid: "76561197960287930", other_steamid: "76561197960287931" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assertNotShown(s.reason);
  });

  test("compare_players succeeds (found:true, 0 shared) when a profile is public but genuinely empty", async (t) => {
    // isPrivate() only trips on {game_count, games} BOTH undefined — a public
    // profile with 0 games ({game_count:0, games:[]}) must NOT be conflated
    // with private and must still report a real (empty) result.
    const { client } = await setupServer(t, ENV, (url) => {
      if (!url.includes("GetOwnedGames")) return jsonResponse({});
      if (url.includes("steamid=76561197960287931")) {
        return jsonResponse({ response: { game_count: 0, games: [] } });
      }
      return jsonResponse(OWNED);
    });
    const res = await client.callTool({
      name: "compare_players",
      arguments: { steamid: "76561197960287930", other_steamid: "76561197960287931" },
    });
    const s = res.structuredContent as { found: boolean; shared_count: number };
    assert.equal(s.found, true);
    assert.equal(s.shared_count, 0);
  });

  // Regression: without include_played_free_games, Steam omits a played
  // free-to-play game from GetOwnedGames entirely — both players' shared
  // f2p game would then silently vanish from the comparison instead of
  // showing up as shared.
  test("compare_players counts a shared free-to-play game (needs include_played_free_games)", async (t) => {
    const { client } = await setupServer(t, ENV, (url) => {
      if (!url.includes("GetOwnedGames")) return jsonResponse({});
      const games = [{ appid: 570, name: "Dota 2", playtime_forever: 120 }];
      if (!url.includes("include_played_free_games=true")) return jsonResponse({ response: {} });
      return jsonResponse({ response: { game_count: games.length, games } });
    });
    const res = await client.callTool({
      name: "compare_players",
      arguments: { steamid: "76561197960287930", other_steamid: "76561197960287931" },
    });
    const s = res.structuredContent as {
      found: boolean;
      shared_count: number;
      games: { appid: number }[];
    };
    assert.equal(s.found, true);
    assert.equal(s.shared_count, 1);
    assert.equal(s.games[0]!.appid, 570);
  });

  test("compare_players reports a transient upstream failure as a retryable tool error, not found:false", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (!url.includes("GetOwnedGames")) return jsonResponse({});
      if (url.includes("steamid=76561197960287931")) return jsonResponse({}, { status: 500 });
      return jsonResponse(OWNED);
    });
    const res = await client.callTool({
      name: "compare_players",
      arguments: { steamid: "76561197960287930", other_steamid: "76561197960287931" },
    });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /\(500\)\. Please retry later/);
  });
});

describe("resolve_vanity_url", () => {
  test("returns the steamid", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    const res = await client.callTool({
      name: "resolve_vanity_url",
      arguments: { vanity: "gabe" },
    });
    const s = res.structuredContent as { found: boolean; steamid: string };
    assert.equal(s.found, true);
    assert.equal(s.steamid, "76561197960287930");
    assert.ok(mock.calls.some((c) => c.url.includes("key=test-key")));
  });

  // Regression: ResolveVanityURL is an exact-match lookup, so leading/trailing
  // whitespace (e.g. pasted from a URL) would otherwise silently resolve to
  // found:false instead of the real profile.
  test("trims surrounding whitespace from the vanity name before sending it upstream", async (t) => {
    const { client, mock } = await setupServer(t, ENV, router);
    const res = await client.callTool({
      name: "resolve_vanity_url",
      arguments: { vanity: "  gabe  " },
    });
    const s = res.structuredContent as { found: boolean; steamid: string };
    assert.equal(s.found, true);
    assert.equal(s.steamid, "76561197960287930");
    assert.ok(
      mock.calls.some((c) => c.url.includes("vanityurl=gabe") && !c.url.includes("vanityurl=%20")),
    );
  });

  // An unmatched vanity name is a normal, successful "no match" result — not a
  // tool error — and Steam's own `message` (when present) is surfaced as the reason.
  test("reports found:false for a vanity name with no match", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("ResolveVanityURL")
        ? jsonResponse({ response: { success: 42, message: "Steam's own words" } })
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "resolve_vanity_url",
      arguments: { vanity: "zzzznobody" },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /No Steam profile has that vanity name/);
    assert.doesNotMatch(s.reason, /Steam's own words/); // agent text is ours only
  });
});

describe("get_game_achievements", () => {
  test("get_game_achievements merges schema names with global rarity (needs key)", async (t) => {
    const { client } = await setupServer(t, ENV, router);
    const res = await client.callTool({ name: "get_game_achievements", arguments: { appid: 620 } });
    const s = res.structuredContent as {
      total: number;
      achievements: { name: string; hidden: boolean; global_unlock_pct: number | null }[];
    };
    assert.equal(s.total, 2);
    assert.equal(s.achievements[0]!.name, "Wake Up Call");
    assert.equal(s.achievements[0]!.global_unlock_pct, 74.2); // merged from global
    assert.equal(s.achievements[1]!.hidden, true);
    assert.equal(s.achievements[1]!.global_unlock_pct, null); // no global entry
  });

  test("get_game_achievements requires a key", async (t) => {
    const { client } = await setupServer(t);
    const res = await client.callTool({ name: "get_game_achievements", arguments: { appid: 620 } });
    assert.equal(res.isError, true);
  });

  test("degrades to a clean empty result for a schema-less appid (e.g. a DLC/soundtrack) instead of a misleading credentials error", async (t) => {
    // As Steam answers it (clients/endpoints.ts, probed live): GetSchemaForGame
    // gives a schema-less DLC an empty `game` (200), the keyless rarity call a
    // 403 "no data". Neither is a credentials problem.
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("GetSchemaForGame")) return jsonResponse({ game: {} });
      if (url.includes("GetGlobalAchievementPercentagesForApp"))
        return recorded("GetGlobalAchievementPercentagesForApp/schema-less-dlc");
      return router(url);
    });
    const res = await client.callTool({
      name: "get_game_achievements",
      arguments: { appid: 1206340 },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as {
      game: string | null;
      total: number;
      achievements: unknown[];
    };
    assert.equal(s.game, null);
    assert.equal(s.total, 0);
    assert.deepEqual(s.achievements, []);
  });

  test("a list missing its rarity is never cached as the list", async (t) => {
    // The cache holds Steam's responses, never a result built from them
    // (lib/cache.ts): a passing rarity failure costs this answer only, noted,
    // and the next call has rarity again.
    let rarityCalls = 0;
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetGlobalAchievementPercentagesForApp") && ++rarityCalls === 1)
        return jsonResponse({}, { status: 503 });
      return router(url);
    });
    const degraded = await client.callTool({
      name: "get_game_achievements",
      arguments: { appid: 620 },
    });
    const d = degraded.structuredContent as { total: number; notes: string[] };
    assert.equal(d.total, 2);
    assert.match(d.notes[0]!, /^Achievement rarity/);

    const retried = await client.callTool({
      name: "get_game_achievements",
      arguments: { appid: 620 },
    });
    const s = retried.structuredContent as {
      achievements: { name: string; percent: number | null }[];
      notes?: string[];
    };
    assert.equal(s.notes, undefined);
    assert.notEqual(s.achievements[0]!.percent, null, "rarity is back, not a cached gap");
  });

  test("returns the schema without rarity on a transient rarity failure, but never caches it", async (t) => {
    // A 5xx on the keyless rarity call alone used to be cached as a list with
    // every global_unlock_pct null for the full TTL.
    let globalCalls = 0;
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (!url.includes("GetGlobalAchievementPercentagesForApp")) return router(url);
      globalCalls++;
      return globalCalls === 1 ? jsonResponse({}, { status: 500 }) : router(url);
    });
    const call = () =>
      client.callTool({ name: "get_game_achievements", arguments: { appid: 620 } });
    type S = { total: number; achievements: { global_unlock_pct: number | null }[] };

    const first = (await call()).structuredContent as S;
    assert.equal(first.total, 2);
    assert.equal(first.achievements[0]!.global_unlock_pct, null);

    const second = (await call()).structuredContent as S;
    assert.equal(second.achievements[0]!.global_unlock_pct, 74.2, "rarity-less result was cached");
  });
});

describe("STEAM_ID default / vanity resolution", () => {
  test("player tools fall back to STEAM_ID (SteamID64) when steamid is omitted", async (t) => {
    const { client, mock } = await setupServer(
      t,
      { ...ENV, STEAM_ID: "76561197960287930" },
      router,
    );
    const res = await client.callTool({ name: "get_owned_games", arguments: {} });
    const s = res.structuredContent as { game_count: number };
    assert.equal(s.game_count, 2);
    // The configured SteamID64 reached the upstream call.
    assert.ok(mock.calls.some((c) => c.url.includes("steamid=76561197960287930")));
  });

  test("a vanity STEAM_ID is resolved once, then reused for player tools", async (t) => {
    const { client, mock } = await setupServer(t, { ...ENV, STEAM_ID: "gabe" }, router);
    const res = await client.callTool({ name: "get_player_summary", arguments: {} });
    const s = res.structuredContent as { found: boolean; steamid: string; level: number };
    assert.equal(s.found, true);
    assert.equal(s.steamid, "76561197960287930");
    assert.equal(s.level, 42); // from GetSteamLevel, merged in alongside the profile
    assert.ok(mock.calls.some((c) => c.url.includes("ResolveVanityURL")));
    assert.ok(mock.calls.some((c) => c.url.includes("GetPlayerSummaries")));
    assert.ok(mock.calls.some((c) => c.url.includes("GetSteamLevel")));
  });

  // A vanity STEAM_ID must not cost the keyless-capable tools their key
  // independence: with a numeric STEAM_ID, get_followed_games and get_wishlist
  // work without a key, and ResolveVanityURL (which needs one) is the only
  // reason they wouldn't. The community profile's ?xml=1 view carries the
  // SteamID64 keylessly, so they still work.
  const PROFILE_XML = (steamid: string) =>
    new Response(`<?xml version="1.0"?><profile><steamID64>${steamid}</steamID64></profile>`, {
      status: 200,
      headers: { "content-type": "text/xml" },
    });

  test("a vanity STEAM_ID resolves without a key, via the community profile", async (t) => {
    const { client, mock } = await setupServer(t, { STEAM_ID: "gabe" }, (url) =>
      url.includes("steamcommunity.com") ? PROFILE_XML("76561197960287930") : router(url),
    ); // no STEAM_API_KEY
    const res = await client.callTool({ name: "get_followed_games", arguments: {} });
    assert.equal(res.isError, undefined);
    const call = mock.calls.find((c) => c.url.includes("steamcommunity.com"))!;
    assert.match(call.url, /steamcommunity\.com\/id\/gabe\/\?xml=1$/);
    // The official lookup is never attempted without a key to send.
    assert.ok(!mock.calls.some((c) => c.url.includes("ResolveVanityURL")));
  });

  test("the keyless fallback also covers a key that the API rejects", async (t) => {
    // A mistyped key 403ing ResolveVanityURL would otherwise take the keyless
    // tools down with it, though neither needs a key of its own.
    const { client } = await setupServer(
      t,
      { ...ENV, STEAM_ID: "gabe", HTTP_RETRIES: "0" },
      (url) => {
        if (url.includes("steamcommunity.com")) return PROFILE_XML("76561197960287930");
        if (url.includes("ResolveVanityURL")) return recorded("ResolveVanityURL/bad-key");
        return router(url);
      },
    );
    const res = await client.callTool({ name: "get_followed_games", arguments: {} });
    assert.equal(res.isError, undefined);
  });

  test("an unresolvable vanity STEAM_ID names the vanity and the numeric way out", async (t) => {
    // A missing profile answers HTTP 200 with an <error> body and no steamID64.
    const { client } = await setupServer(t, { STEAM_ID: "nobody-such-vanity" }, (url) =>
      url.includes("steamcommunity.com")
        ? new Response(
            "<response><error>The specified profile could not be found.</error></response>",
            {
              status: 200,
              headers: { "content-type": "text/xml" },
            },
          )
        : jsonResponse({}),
    );
    const res = await client.callTool({ name: "get_followed_games", arguments: {} });
    assertToolError(res, /Could not resolve the STEAM_ID vanity name "nobody-such-vanity"/);
    assertToolError(res, /17-digit SteamID64/);
  });

  // Only a page without a steamID64 speaks to the name; a failure of any
  // status (a 403 edge block as much as a 503) says nothing about it.
  for (const status of [503, 403]) {
    test(`a vanity STEAM_ID whose profile lookup failed (${status}) isn't blamed on its spelling`, async (t) => {
      const { client } = await setupServer(t, { STEAM_ID: "gabe", HTTP_RETRIES: "0" }, (url) =>
        url.includes("steamcommunity.com") ? jsonResponse({}, { status }) : router(url),
      ); // no key: the community profile is the only attempt
      const res = await client.callTool({ name: "get_followed_games", arguments: {} });
      assert.equal(res.isError, true);
      const text = (res.content as { text: string }[])[0]!.text;
      assert.doesNotMatch(text, /check the spelling/);
    });
  }

  // Only the two answers seen live settle it; an outage's HTML 200 doesn't.
  test("a community page that is neither answer isn't read as 'no such profile'", async (t) => {
    const { client } = await setupServer(t, { STEAM_ID: "gabe", HTTP_RETRIES: "0" }, (url) =>
      url.includes("steamcommunity.com")
        ? htmlResponse("<html>Busy</html>", { status: 200 })
        : router(url),
    );
    const res = await client.callTool({ name: "get_followed_games", arguments: {} });
    assertToolError(res, /unusable/);
    assert.doesNotMatch((res.content as { text: string }[])[0]!.text, /check the spelling/);
  });

  test("a definitive 'no such profile' wins over a keyed attempt that hit a 429", async (t) => {
    const { client } = await setupServer(
      t,
      { ...ENV, STEAM_ID: "nobody-such-vanity", HTTP_RETRIES: "0" },
      (url) => {
        if (url.includes("ResolveVanityURL")) return jsonResponse({}, { status: 429 });
        if (url.includes("steamcommunity.com"))
          return new Response(
            "<response><error>The specified profile could not be found.</error></response>",
            {
              status: 200,
              headers: { "content-type": "text/xml" },
            },
          );
        return router(url);
      },
    );
    const res = await client.callTool({ name: "get_followed_games", arguments: {} });
    assertToolError(res, /Could not resolve the STEAM_ID vanity name "nobody-such-vanity"/);
  });

  // The API's "No match" (success 42, seen live) settles it: the community
  // profile isn't asked, so its outage can't replace the answer.
  test("a vanity STEAM_ID the API answers 'No match' for errors clearly", async (t) => {
    const { client, mock } = await setupServer(
      t,
      { ...ENV, STEAM_ID: "nobody-such-vanity" },
      (url) =>
        url.includes("ResolveVanityURL")
          ? jsonResponse({ response: { success: 42, message: "No match" } })
          : jsonResponse({}, { status: 503 }),
    );
    const res = await client.callTool({ name: "get_followed_games", arguments: {} });
    assertToolError(res, /Could not resolve the STEAM_ID vanity name "nobody-such-vanity"/);
    assert.ok(!mock.calls.some((c) => c.url.includes("steamcommunity.com")));
  });

  // Only 1 and 42 are answers; another EResult says nothing about the name.
  test("resolve_vanity_url: a result that isn't OK or No match is a failure, not 'no profile'", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) =>
      url.includes("ResolveVanityURL")
        ? jsonResponse({ response: { success: 2 } })
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "resolve_vanity_url",
      arguments: { vanity: "gabe" },
    });
    assertToolError(res, /unusable/i);
  });

  // An answer is keyed by the status seen (400), not its code: a 405 or 422
  // is also bad_request, and was never seen to mean "no schema".
  test("get_game_achievements: a JSON 405 is an error, not 'no schema'", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetSchemaForGame") ? jsonResponse({}, { status: 405 }) : jsonResponse({}),
    );
    const res = await client.callTool({ name: "get_game_achievements", arguments: { appid: 620 } });
    assertToolError(res, /\(405\)/);
    assert.doesNotMatch((res.content as { text: string }[])[0]!.text, /no achievement schema/);
  });

  test("player tools error clearly when steamid is omitted and STEAM_ID is unset", async (t) => {
    const { client } = await setupServer(t, ENV, router); // key set, but no STEAM_ID
    const res = await client.callTool({ name: "get_player_summary", arguments: {} });
    assertToolError(res, /STEAM_ID/);
  });
});

test("get_player_summary still succeeds (level:null) when GetSteamLevel itself fails", async (t) => {
  // #steamLevel's own try/catch must never turn a working profile lookup into
  // a tool error — a level fetch failure degrades to null, nothing more.
  const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) =>
    url.includes("GetSteamLevel") ? jsonResponse({}, { status: 500 }) : router(url),
  );
  const res = await client.callTool({
    name: "get_player_summary",
    arguments: { steamid: "76561197960287930" },
  });
  assert.equal(res.isError, undefined);
  const s = res.structuredContent as { found: boolean; level: number | null };
  assert.equal(s.found, true);
  assert.equal(s.level, null);
});

test("get_player_summary: no such account (an empty 200, probed live) reports found:false", async (t) => {
  // Unlike the per-player IPlayerService endpoints, GetPlayerSummaries never
  // 400s for a bad id (not even accountid 0): no account is an empty list.
  const { client } = await setupServer(t, ENV, (url) =>
    url.includes("GetPlayerSummaries") ? jsonResponse({ response: { players: [] } }) : router(url),
  );
  const res = await client.callTool({
    name: "get_player_summary",
    arguments: { steamid: "76561197960287930" },
  });
  assert.equal(res.isError, undefined);
  const s = res.structuredContent as { found: boolean };
  assert.equal(s.found, false);
});

test("get_player_bans: no such account (an empty 200, probed live) reports found:false", async (t) => {
  const { client } = await setupServer(t, ENV, (url) =>
    url.includes("GetPlayerBans") ? jsonResponse({ players: [] }) : router(url),
  );
  const res = await client.callTool({
    name: "get_player_bans",
    arguments: { steamid: "76561197960287930" },
  });
  assert.equal(res.isError, undefined);
  const s = res.structuredContent as { found: boolean };
  assert.equal(s.found, false);
});

test("get_player_bans reports ban status by steamid", async (t) => {
  const { client } = await setupServer(t, ENV, router);
  const res = await client.callTool({
    name: "get_player_bans",
    arguments: { steamid: "76561197960287930" },
  });
  const s = res.structuredContent as {
    found: boolean;
    vac_banned: boolean;
    vac_ban_count: number;
    game_ban_count: number;
    community_banned: boolean;
    economy_ban: string | null;
    days_since_last_ban: number | null;
  };
  assert.equal(s.found, true);
  assert.equal(s.vac_banned, true);
  assert.equal(s.vac_ban_count, 1);
  assert.equal(s.game_ban_count, 0);
  assert.equal(s.community_banned, false);
  assert.equal(s.economy_ban, null); // EconomyBan "none" → null
  assert.equal(s.days_since_last_ban, 100); // a real ban exists → surfaced
});

test("get_player_bans: days_since_last_ban is null for a never-banned player", async (t) => {
  // Steam returns DaysSinceLastBan: 0 for players with no ban history; surfacing
  // it verbatim reads as "banned today", so a clean record must report null.
  const cleanRouter = (url: string) =>
    url.includes("GetPlayerBans")
      ? jsonResponse({
          players: [
            {
              SteamId: "76561197960287930",
              CommunityBanned: false,
              VACBanned: false,
              NumberOfVACBans: 0,
              NumberOfGameBans: 0,
              DaysSinceLastBan: 0,
              EconomyBan: "none",
            },
          ],
        })
      : router(url);
  const { client } = await setupServer(t, ENV, cleanRouter);
  const res = await client.callTool({
    name: "get_player_bans",
    arguments: { steamid: "76561197960287930" },
  });
  const s = res.structuredContent as { days_since_last_ban: number | null; vac_banned: boolean };
  assert.equal(s.vac_banned, false);
  assert.equal(s.days_since_last_ban, null);
});

test("a tool call the client cancels aborts its outstanding Steam request", async (t) => {
  let aborted = false;
  const { client } = await setupServer(t, ENV, (url, init) => {
    if (!url.includes("GetNumberOfCurrentPlayers")) return jsonResponse({});
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  });
  const ac = new AbortController();
  const call = client.callTool(
    { name: "get_current_players", arguments: { appid: 620 } },
    { signal: ac.signal },
  );
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(call);
  for (let i = 0; i < 50 && !aborted; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(aborted, true, "the server stopped its fetch instead of letting it run on");
});

// accountid 0 (Steam's 400) and an id past the 32-bit account range name no
// account by construction: refused at the tool boundary, before any request,
// so no 400 ever has to be read as "no such account".
describe("a SteamID64 that can't name an account is refused before any call", () => {
  const ME = "76561197960287930";
  for (const [tool, args] of [
    ["get_player_summary", {}],
    ["get_player_bans", {}],
    ["get_owned_games", {}],
    ["get_recently_played", {}],
    ["get_player_achievements", { appid: 620 }],
    ["get_friend_list", {}],
    ["find_friends_who_own", { appids: [620] }],
    ["get_recommended_games", {}],
    ["get_wishlist", {}],
    ["get_followed_games", {}],
  ] as const) {
    for (const id of ["76561197960265728", "76561202255233024"]) {
      test(`${tool}(${id})`, async (t) => {
        const { client, mock } = await setupServer(t, ENV);
        const res = await client.callTool({ name: tool, arguments: { steamid: id, ...args } });
        assertToolError(res, /from 76561197960265729 to 76561202255233023/);
        assert.equal(mock.calls.length, 0);
      });
    }
  }

  test("compare_players' other_steamid too", async (t) => {
    const { client, mock } = await setupServer(t, ENV);
    const res = await client.callTool({
      name: "compare_players",
      arguments: { steamid: ME, other_steamid: "76561197960265728" },
    });
    assertToolError(res, /from 76561197960265729 to 76561202255233023/);
    assert.equal(mock.calls.length, 0);
  });

  // The same check, once, at startup: like a bad STEAM_LANGUAGE.
  test("so is a configured STEAM_ID default, when the config loads", () => {
    assert.throws(
      () => loadConfig({ ...ENV, STEAM_ID: "76561197960265728" }),
      /STEAM_ID: A SteamID64 is a 17-digit number from 76561197960265729/,
    );
    assert.equal(
      loadConfig({ ...ENV, STEAM_ID: "gabelogannewell" }).defaultSteamId,
      "gabelogannewell",
    );
  });

  test("the account range's own ends are accepted", async (t) => {
    const { client } = await setupServer(t, ENV, router);
    for (const id of ["76561197960265729", "76561202255233023"]) {
      const res = await client.callTool({ name: "get_player_bans", arguments: { steamid: id } });
      assert.equal(res.isError, undefined, id);
    }
  });
});

// A field a verdict is read from must be in the body; absent, the answer is
// unusable (retryable), never "no such app", "no achievements", "private" or
// "available" by default.
describe("a body missing the field a whole-body verdict rests on is unusable", () => {
  for (const [tool, args, endpoint, body] of [
    ["get_current_players", { appid: 620 }, "GetNumberOfCurrentPlayers", { response: {} }],
    ["get_game_achievements", { appid: 620 }, "GetSchemaForGame", {}],
    [
      "get_player_summary",
      { steamid: "76561197960287930" },
      "GetPlayerSummaries",
      { response: {} },
    ],
    ["get_player_bans", { steamid: "76561197960287930" }, "GetPlayerBans", {}],
    ["get_friend_list", { steamid: "76561197960287930" }, "GetFriendList", {}],
    ["get_global_achievements", { appid: 620 }, "GetGlobalAchievementPercentagesForApp", {}],
    [
      "get_player_achievements",
      { steamid: "76561197960287930", appid: 620 },
      "GetPlayerAchievements",
      { playerstats: {} },
    ],
  ] as const) {
    test(`${tool}: ${endpoint} without it`, async (t) => {
      const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) =>
        url.includes(endpoint) ? jsonResponse(body) : router(url),
      );
      const res = await client.callTool({ name: tool, arguments: args });
      assertToolError(res, /unusable/);
    });
  }
});

// A fact about one item of a batch is decided per row: one odd item (Steam
// sends appid 4294967295 back with success 8 and no visible) costs its own
// row only.
test("get_items: an item Steam returns no card for is its own unavailable row", async (t) => {
  const { client } = await setupServer(t, ENV, (url) =>
    url.includes("IStoreBrowseService/GetItems")
      ? jsonResponse({
          response: {
            store_items: [
              { appid: 620, visible: true, success: 1, name: "Portal 2" },
              { appid: 4294967295, success: 8 },
            ],
          },
        })
      : router(url),
  );
  const res = await client.callTool({
    name: "get_items",
    arguments: { appids: [620, 4294967295] },
  });
  const s = res.structuredContent as { items: { appid: number; available: boolean }[] };
  assert.deepEqual(
    s.items.map((i) => [i.appid, i.available]),
    [
      [620, true],
      [4294967295, false],
    ],
  );
});

// An empty friends list was never seen public; an absent `friends` reads as
// none (protobuf-backed APIs omit an empty repeated field).
// ISteamUser writes its list out: zero friends is {"friends":[]} (seen live
// 2026-11-20); a friendslist without the list isn't Steam's "none".
test("get_friend_list: friends [] is zero friends; no list at all is no answer", async (t) => {
  for (const [friendslist, zero] of [
    [{ friends: [] }, true],
    [{}, false],
  ] as const) {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) =>
      url.includes("GetFriendList") ? jsonResponse({ friendslist }) : router(url),
    );
    const res = await client.callTool({
      name: "get_friend_list",
      arguments: { steamid: "76561197960287930" },
    });
    if (zero) assert.equal((res.structuredContent as { total: number }).total, 0);
    else assertToolError(res, /unusable response/i);
  }
});
