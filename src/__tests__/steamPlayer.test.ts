// Integration tests for the key-gated player tools (profile, bans, library,
// achievements, friends, vanity resolution) — mirrors tools/webPlayer.ts. Split
// out of a single steam.test.ts once it grew past 1600 lines; see
// steamStorefront.test.ts (Storefront tools) and steamCatalog.test.ts
// (keyless-capable Web API store tools).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupServer, jsonResponse, htmlResponse, assertToolError } from "./helpers.js";
import { ENV, FRIENDLIST, OWNED, PLAYERS, SCHEMA, router } from "./steamFixtures.js";

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
  test("get_player_achievements: success:false and the schema lookup ALSO fails → generic fallback reason", async (t) => {
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
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /achievements unavailable/i);
  });
});

describe("get_friend_list", () => {
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

  test("a GetPlayerSummaries chunk failure (150-friend list, 2 chunks) doesn't sink the whole call", async (t) => {
    // #playerSummaries chunks at 100 ids/call. Build a 150-friend list so the
    // enrichment call spans two chunks, and fail only the second one — the
    // first 100 friends' names must still come through, not a hard error.
    const manyFriends = Array.from({ length: 150 }, (_, i) => ({
      steamid: `765611979602${String(87930 + i).padStart(5, "0")}`,
      relationship: "friend",
      friend_since: 1600000000 + i,
    }));
    const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) => {
      if (url.includes("GetFriendList"))
        return jsonResponse({ friendslist: { friends: manyFriends } });
      if (url.includes("GetPlayerSummaries")) {
        // The 101st friend (index 100) only appears in the second chunk's
        // steamids list — use it to distinguish which chunk this call is.
        if (url.includes(manyFriends[100]!.steamid)) return jsonResponse({}, { status: 500 });
        return jsonResponse({
          response: {
            players: manyFriends
              .filter((f) => url.includes(f.steamid))
              .map((f) => ({ steamid: f.steamid, personaname: `Friend ${f.steamid}` })),
          },
        });
      }
      return jsonResponse({});
    });
    const res = await client.callTool({
      name: "get_friend_list",
      arguments: { steamid: "76561197960287930" },
    });
    assert.equal(res.isError, undefined);
    const s = res.structuredContent as {
      found: boolean;
      total: number;
      returned: number;
      friends: { steamid: string; name: string | null }[];
    };
    assert.equal(s.found, true);
    assert.equal(s.total, 150);
    // get_friend_list's own 100-most-recent cap keeps friends 50-149 (by
    // friend_since desc) — friend 60 (chunk 1, succeeded) and friend 120
    // (chunk 2, failed) are both within that window, on opposite sides of
    // the #playerSummaries chunk boundary (chunks split at raw index 100).
    assert.equal(s.returned, 100);
    const byId = new Map(s.friends.map((f) => [f.steamid, f.name]));
    assert.equal(byId.get(manyFriends[60]!.steamid), `Friend ${manyFriends[60]!.steamid}`);
    assert.equal(byId.get(manyFriends[120]!.steamid), null);
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
  };
  assert.equal(s.found, true);
  assert.equal(s.vac_banned, true);
  assert.equal(s.vac_ban_count, 1);
  assert.equal(s.game_ban_count, 0);
  assert.equal(s.community_banned, false);
  assert.equal(s.economy_ban, null); // EconomyBan "none" → null
});
