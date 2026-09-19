// Integration tests for the key-gated player tools (profile, bans, library,
// achievements, friends, vanity resolution) — mirrors tools/webPlayer.ts. Split
// out of a single steam.test.ts once it grew past 1600 lines; see
// steamStorefront.test.ts (Storefront tools) and steamCatalog.test.ts
// (keyless-capable Web API store tools).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupServer, jsonResponse, htmlResponse, assertToolError, textOf } from "./helpers.js";
import { ENV, FRIENDLIST, OWNED, PLAYERS, SCHEMA, router } from "./steamFixtures.js";
import { FRIENDS_CHECKED_MAX, FRIENDS_MAX } from "../format/web.js";
import { OWNED_GAMES_LIMIT_MAX } from "../tools/webPlayer.js";

// Steam answers a raw, non-JSON HTTP 400 (not its usual empty-200 response) for
// some malformed/out-of-range steamids — e.g. the SteamID64 base constant
// (accountid 0), which is 17 digits and passes the tool schema but is never a
// real account. Regression coverage for that raw body leaking to the agent.
const ROUTING_400 =
  "<html><body><h1>Bad Request</h1>Missing required routing parameter</body></html>";

test("player tools error clearly without STEAM_API_KEY", async (t) => {
  const { client } = await setupServer(t);
  const res = await client.callTool({
    name: "get_owned_games",
    arguments: { steamid: "76561197960287930" },
  });
  assertToolError(res, /STEAM_API_KEY/);
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
    assert.match(s.reason, /private/i);
  });

  test("get_owned_games: a malformed/out-of-range steamid reports found:false, not a raw HTML error", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetOwnedGames") ? htmlResponse(ROUTING_400) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "76561197960265728" }, // accountid 0
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /private/i);
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
    const { client } = await setupServer(t, ENV, router);
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

  test("get_recently_played: a malformed/out-of-range steamid reports found:false, not a raw HTML error", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetRecentlyPlayedGames") ? htmlResponse(ROUTING_400) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_recently_played",
      arguments: { steamid: "76561197960265728" }, // accountid 0
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; total: number; games: unknown[] };
    assert.equal(s.found, false);
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
      return jsonResponse({
        response: {
          store_items: [
            { appid: 10, tags: [{ tagid: 1, weight: 900 }] },
            { appid: 20, tags: [{ tagid: 2, weight: 900 }] },
          ],
        },
      });
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

  test("get_recommended_games: exclude_tags drops matching candidates end-to-end", async (t) => {
    const { client } = await setupServer(t, ENV, (url) => {
      if (url.includes("IStoreQueryService/Query")) {
        return jsonResponse({
          response: {
            store_items: [
              {
                appid: 30,
                name: "New Roguelike",
                visible: true,
                tags: [{ tagid: 1, weight: 900 }],
                reviews: { summary_filtered: { percent_positive: 95 } },
              },
              {
                appid: 50,
                name: "Souls-like Roguelike",
                visible: true,
                // Souls-like present but low-weighted — exclusion must still see it.
                tags: [
                  { tagid: 1, weight: 900 },
                  { tagid: 3, weight: 1 },
                ],
              },
            ],
          },
        });
      }
      return recoRouter(url);
    });
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930", exclude_tags: ["Souls-like"] },
    });
    const s = res.structuredContent as { recommendations: { appid: number }[] };
    assert.deepEqual(
      s.recommendations.map((r) => r.appid),
      [30],
    );
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

  test("get_recommended_games reports found:false for a private profile", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetOwnedGames") ? jsonResponse({ response: {} }) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /private/i);
  });

  test("get_recommended_games: a malformed/out-of-range steamid reports found:false, not a raw HTML error", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetOwnedGames") ? htmlResponse(ROUTING_400) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_recommended_games",
      arguments: { steamid: "76561197960265728" }, // accountid 0
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /private/i);
  });

  test("get_recommended_games reports found:false for a PUBLIC profile with zero games (distinct from private)", async (t) => {
    // web.ts's own private-profile check (games/game_count both undefined)
    // never fires here — this is storeService.getRecommendedGames' OWN
    // "ownedGames.length === 0" branch, reached only once the profile is
    // confirmed public but genuinely empty.
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetOwnedGames")
        ? jsonResponse({ response: { game_count: 0, games: [] } })
        : jsonResponse({}),
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
        return jsonResponse({ response: { store_items: [{ appid: 10 }] } }); // no tags
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

  test("get_player_achievements: private profile (403) → clear private reason", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetPlayerAchievements")
        ? jsonResponse(
            { playerstats: { error: "Profile is not public", success: false } },
            { status: 403 },
          )
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /private/i);
  });

  test("get_player_achievements: 200 + success:false with a 'not public' error → private reason (no schema lookup needed)", async (t) => {
    // Distinct from the 403 case above: here the HTTP call itself succeeds
    // (200), so #getPlayerAchievements never throws/catches — the private
    // disambiguation instead comes from #explainNoPlayerAchievements' OWN
    // apiError-message regex, short-circuiting before it ever calls
    // GetSchemaForGame (unlike the no-achievements/hidden tests below).
    const { client, mock } = await setupServer(t, ENV, (url) =>
      url.includes("GetPlayerAchievements")
        ? jsonResponse({ playerstats: { success: false, error: "Profile is not public" } })
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /private/i);
    assert.ok(!mock.calls.some((c) => c.url.includes("GetSchemaForGame")));
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
    assert.match(s.reason, /hidden|private/i);
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
    // The other half of the same branch: a 403 is about this appid/key, not a
    // blip, so it stays a found:false answer rather than a retryable error.
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetPlayerAchievements"))
        return jsonResponse({ playerstats: { success: false } });
      if (url.includes("GetSchemaForGame")) return jsonResponse({}, { status: 403 });
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /achievements unavailable/i);
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
      url.includes("GetFriendList") ? jsonResponse({}, { status: 401 }) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_friend_list",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /friends list/i);
  });

  test("get_friend_list: a malformed/out-of-range steamid reports found:false, not a raw HTML error", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetFriendList") ? htmlResponse(ROUTING_400) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "get_friend_list",
      arguments: { steamid: "76561197960265728" }, // accountid 0
    });
    assert.equal(res.isError, undefined);
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
      url.includes("GetFriendList")
        ? jsonResponse({ error: "No matching resource was found" }, { status: 404 })
        : jsonResponse({}),
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
    const { client } = await setupServer(t, ENV, (url) => {
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
      private_friends: { steamid: string; name: string | null }[];
    };
    assert.equal(s.total_friends, 2);
    const m620 = s.matches.find((m) => m.appid === 620)!;
    assert.equal(m620.owners.length, 1);
    assert.equal(m620.owners[0]!.name, "Rabscuttle");
    // OWNED gives appid 620 a playtime_forever of 600 minutes = 10h.
    assert.equal(m620.owners[0]!.playtime_hours, 10);
    const m999 = s.matches.find((m) => m.appid === 999)!;
    assert.equal(m999.owners.length, 0);
    assert.equal(s.private_friends.length, 1);
    assert.equal(s.private_friends[0]!.steamid, "76561197960287931");
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
      private_friends: { steamid: string }[];
      unavailable_friends: { steamid: string; reason: string }[];
    };
    assert.equal(s.total_friends, 2);
    // The healthy friend's ownership still comes through untouched.
    const m620 = s.matches.find((m) => m.appid === 620)!;
    assert.equal(m620.owners.length, 1);
    assert.equal(m620.owners[0]!.steamid, "76561197960287930");
    assert.equal(m620.owners[0]!.playtime_hours, 10);
    // The failing friend is unavailable, NOT counted as private.
    assert.equal(s.private_friends.length, 0);
    assert.equal(s.unavailable_friends.length, 1);
    assert.equal(s.unavailable_friends[0]!.steamid, "76561197960287931");
    assert.match(s.unavailable_friends[0]!.reason, /5xx|500|retry later/i);
    // The raw upstream error body must never reach this field verbatim — it's
    // sanitized the same way a top-level tool failure's message is (messageFor()),
    // not embedded as-is (which could otherwise leak raw HTML/error-page text).
    assert.doesNotMatch(s.unavailable_friends[0]!.reason, /server exploded/);
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
              .map((f) => ({ steamid: f.steamid, personaname: `Friend ${f.steamid}` })),
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

  test("find_friends_who_own reports found:false for a private friends list (403)", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetFriendList") ? jsonResponse({}, { status: 403 }) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620], steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /friends list/i);
  });

  test("find_friends_who_own: a malformed/out-of-range steamid reports found:false, not a raw HTML error", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetFriendList") ? htmlResponse(ROUTING_400) : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620], steamid: "76561197960265728" }, // accountid 0
    });
    assert.equal(res.isError, undefined);
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
      private_friends: unknown[];
    };
    assert.equal(s.total_friends, 0);
    assert.equal(s.matches.length, 2); // both requested appids still reported, just with no owners
    assert.ok(s.matches.every((m) => m.owners.length === 0));
    assert.equal(s.private_friends.length, 0);
  });

  // Regression: without include_played_free_games, Steam omits a played
  // free-to-play game from a friend's GetOwnedGames entirely — an owning
  // friend would then be silently missing from `owners` (not even landing
  // in private_friends/unavailable_friends), contradicting "checks each
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
      private_friends: unknown[];
    };
    const m570 = s.matches.find((m) => m.appid === 570)!;
    assert.equal(m570.owners.length, 2);
    assert.equal(s.private_friends.length, 0);
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
    assert.match(s.reason, /private/i);
  });

  test("compare_players: a malformed/out-of-range other_steamid reports found:false, not a raw HTML error", async (t) => {
    const { client } = await setupServer(t, ENV, (url) => {
      if (!url.includes("GetOwnedGames")) return jsonResponse({});
      if (url.includes("steamid=76561197960265728")) return htmlResponse(ROUTING_400);
      return jsonResponse(OWNED);
    });
    const res = await client.callTool({
      name: "compare_players",
      arguments: { steamid: "76561197960287930", other_steamid: "76561197960265728" }, // accountid 0
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /private/i);
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

  test("compare_players reports found:false naming which player failed on a genuine transient error, not a raw thrown error", async (t) => {
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (!url.includes("GetOwnedGames")) return jsonResponse({});
      if (url.includes("steamid=76561197960287931")) return jsonResponse({}, { status: 500 });
      return jsonResponse(OWNED);
    });
    const res = await client.callTool({
      name: "compare_players",
      arguments: { steamid: "76561197960287930", other_steamid: "76561197960287931" },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /second player/i);
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
        ? jsonResponse({ response: { success: 42, message: "No match" } })
        : jsonResponse({}),
    );
    const res = await client.callTool({
      name: "resolve_vanity_url",
      arguments: { vanity: "zzzznobody" },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /no match/i);
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
    // Regression: Steam answers 403 on GetSchemaForGame for an appid with no
    // achievement schema — verified live. GetGlobalAchievementPercentagesForApp
    // (keyless) rejecting the same way for the same appid is the appid-specific
    // signal that distinguishes this from a genuinely bad key.
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetSchemaForGame") || url.includes("GetGlobalAchievementPercentagesForApp")
        ? jsonResponse({}, { status: 403 })
        : router(url),
    );
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

  test("still surfaces a credentials-flavored error when only the schema call 403s and the keyless global-rarity call succeeds (genuinely ambiguous)", async (t) => {
    const { client } = await setupServer(t, ENV, (url) =>
      url.includes("GetSchemaForGame") ? jsonResponse({}, { status: 403 }) : router(url),
    );
    const res = await client.callTool({ name: "get_game_achievements", arguments: { appid: 620 } });
    assert.equal(res.isError, true);
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

  // requireSteamId's own "needs a key to resolve" branch (web.ts) is unreachable
  // from webPlayer.ts tools — requireKey there already gates on the key first.
  // It's only reachable via a keyless-capable tool (get_followed_games), which
  // resolves STEAM_ID without requiring a key overall.
  test("a vanity STEAM_ID without a key errors clearly (needs STEAM_API_KEY to resolve it)", async (t) => {
    const { client } = await setupServer(t, { STEAM_ID: "gabe" }, router); // no STEAM_API_KEY
    const res = await client.callTool({ name: "get_followed_games", arguments: {} });
    assertToolError(res, /STEAM_API_KEY/);
  });

  test("a vanity STEAM_ID that fails to resolve errors clearly", async (t) => {
    const { client } = await setupServer(t, { ...ENV, STEAM_ID: "nobody-such-vanity" }, (url) =>
      url.includes("ResolveVanityURL")
        ? jsonResponse({ response: { success: 42 } }) // no steamid — unresolvable
        : jsonResponse({}),
    );
    const res = await client.callTool({ name: "get_followed_games", arguments: {} });
    assertToolError(res, /could not resolve/i);
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

test("get_player_summary: a raw HTTP 400 from GetPlayerSummaries reports found:false, not a raw error", async (t) => {
  // Defensive parity with every other steamid-taking client method (getOwnedGames,
  // getRecentlyPlayed, getWishlist, getFollowedGames) — none of them are known
  // to actually 400 live, but if Steam ever does, it must degrade the same way.
  const { client } = await setupServer(t, ENV, (url) =>
    url.includes("GetPlayerSummaries") ? jsonResponse({}, { status: 400 }) : router(url),
  );
  const res = await client.callTool({
    name: "get_player_summary",
    arguments: { steamid: "76561197960287930" },
  });
  assert.equal(res.isError, undefined);
  const s = res.structuredContent as { found: boolean };
  assert.equal(s.found, false);
});

test("get_player_bans: a raw HTTP 400 from GetPlayerBans reports found:false, not a raw error", async (t) => {
  const { client } = await setupServer(t, ENV, (url) =>
    url.includes("GetPlayerBans") ? jsonResponse({}, { status: 400 }) : router(url),
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
