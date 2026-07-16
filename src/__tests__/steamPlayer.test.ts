// Integration tests for the key-gated player tools (profile, bans, library,
// achievements, friends, vanity resolution) — mirrors tools/webPlayer.ts. Split
// out of a single steam.test.ts once it grew past 1600 lines; see
// steamStorefront.test.ts (Storefront tools) and steamCatalog.test.ts
// (keyless-capable Web API store tools).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { connectServer, installFetch, mockFetch, jsonResponse } from "./helpers.js";
import { ENV, FRIENDLIST, OWNED, PLAYERS, SCHEMA, router } from "./steamFixtures.js";

test("player tools error clearly without STEAM_API_KEY", async (t) => {
  const { client, close } = await connectServer({});
  t.after(close);
  const res = await client.callTool({
    name: "get_owned_games",
    arguments: { steamid: "76561197960287930" },
  });
  assert.equal(res.isError, true);
  const text = (res.content as { text: string }[])[0]!.text;
  assert.match(text, /STEAM_API_KEY/);
});

describe("get_owned_games", () => {
  test("get_owned_games sorts by playtime and converts to hours", async (t) => {
    installFetch(t, mockFetch(router));
    const { client, close } = await connectServer(ENV);
    t.after(close);
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
    installFetch(
      t,
      mockFetch((url) =>
        url.includes("GetOwnedGames") ? jsonResponse({ response: {} }) : jsonResponse({}),
      ),
    );
    const { client, close } = await connectServer(ENV);
    t.after(close);
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
});

describe("get_player_achievements", () => {
  test("get_player_achievements computes completion", async (t) => {
    installFetch(t, mockFetch(router));
    const { client, close } = await connectServer(ENV);
    t.after(close);
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
    const mock = mockFetch(router);
    installFetch(t, mock);
    const { client, close } = await connectServer(ENV);
    t.after(close);
    await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620, language: "russian" },
    });
    const u = mock.calls.find((c) => c.url.includes("GetPlayerAchievements"))!.url;
    assert.match(u, /l=russian/);
  });

  test("get_player_achievements: private profile (403) → clear private reason", async (t) => {
    installFetch(
      t,
      mockFetch((url) =>
        url.includes("GetPlayerAchievements")
          ? jsonResponse(
              { playerstats: { error: "Profile is not public", success: false } },
              { status: 403 },
            )
          : jsonResponse({}),
      ),
    );
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /private/i);
  });

  test("get_player_achievements: success:false + game has no achievements", async (t) => {
    installFetch(
      t,
      mockFetch((url) => {
        if (url.includes("GetPlayerAchievements"))
          return jsonResponse({ playerstats: { success: false } });
        if (url.includes("GetSchemaForGame"))
          return jsonResponse({ game: { availableGameStats: { achievements: [] } } });
        return jsonResponse({});
      }),
    );
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /no achievements/i);
  });

  test("get_player_achievements: success:false but game HAS achievements → hidden/private", async (t) => {
    installFetch(
      t,
      mockFetch((url) => {
        if (url.includes("GetPlayerAchievements"))
          return jsonResponse({ playerstats: { success: false } });
        if (url.includes("GetSchemaForGame")) return jsonResponse(SCHEMA); // 2 achievements
        return jsonResponse({});
      }),
    );
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /hidden|private/i);
  });
});

describe("get_friend_list", () => {
  test("get_friend_list merges names and sorts most-recent-friend-first", async (t) => {
    installFetch(t, mockFetch(router));
    const { client, close } = await connectServer(ENV);
    t.after(close);
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
    installFetch(
      t,
      mockFetch((url) =>
        url.includes("GetFriendList") ? jsonResponse({}, { status: 401 }) : jsonResponse({}),
      ),
    );
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({
      name: "get_friend_list",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /friends list/i);
  });
});

describe("find_friends_who_own", () => {
  test("find_friends_who_own checks each friend's FULL library and separates private ones", async (t) => {
    installFetch(
      t,
      mockFetch((url) => {
        if (url.includes("GetFriendList")) return jsonResponse(FRIENDLIST);
        if (url.includes("GetPlayerSummaries")) return jsonResponse(PLAYERS);
        if (url.includes("GetOwnedGames")) {
          // 76561197960287931's library is private; the other owns 620 + 400.
          if (url.includes("steamid=76561197960287931")) return jsonResponse({ response: {} });
          return jsonResponse(OWNED);
        }
        return jsonResponse({});
      }),
    );
    const { client, close } = await connectServer(ENV);
    t.after(close);
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

  test("find_friends_who_own reports found:false for a private friends list (403)", async (t) => {
    installFetch(
      t,
      mockFetch((url) =>
        url.includes("GetFriendList") ? jsonResponse({}, { status: 403 }) : jsonResponse({}),
      ),
    );
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({
      name: "find_friends_who_own",
      arguments: { appids: [620], steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /friends list/i);
  });
});

test("resolve_vanity_url returns the steamid", async (t) => {
  const mock = mockFetch(router);
  installFetch(t, mock);
  const { client, close } = await connectServer(ENV);
  t.after(close);
  const res = await client.callTool({
    name: "resolve_vanity_url",
    arguments: { vanity: "gabe" },
  });
  const s = res.structuredContent as { found: boolean; steamid: string };
  assert.equal(s.found, true);
  assert.equal(s.steamid, "76561197960287930");
  assert.ok(mock.calls.some((c) => c.url.includes("key=test-key")));
});

describe("get_game_achievements", () => {
  test("get_game_achievements merges schema names with global rarity (needs key)", async (t) => {
    installFetch(t, mockFetch(router));
    const { client, close } = await connectServer(ENV);
    t.after(close);
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
    const { client, close } = await connectServer({});
    t.after(close);
    const res = await client.callTool({ name: "get_game_achievements", arguments: { appid: 620 } });
    assert.equal(res.isError, true);
  });
});

test("player tools fall back to STEAM_ID (SteamID64) when steamid is omitted", async (t) => {
  const mock = mockFetch(router);
  installFetch(t, mock);
  const { client, close } = await connectServer({ ...ENV, STEAM_ID: "76561197960287930" });
  t.after(close);
  const res = await client.callTool({ name: "get_owned_games", arguments: {} });
  const s = res.structuredContent as { game_count: number };
  assert.equal(s.game_count, 2);
  // The configured SteamID64 reached the upstream call.
  assert.ok(mock.calls.some((c) => c.url.includes("steamid=76561197960287930")));
});

test("a vanity STEAM_ID is resolved once, then reused for player tools", async (t) => {
  const mock = mockFetch(router);
  installFetch(t, mock);
  const { client, close } = await connectServer({ ...ENV, STEAM_ID: "gabe" });
  t.after(close);
  const res = await client.callTool({ name: "get_player_summary", arguments: {} });
  const s = res.structuredContent as { found: boolean; steamid: string; level: number };
  assert.equal(s.found, true);
  assert.equal(s.steamid, "76561197960287930");
  assert.equal(s.level, 42); // from GetSteamLevel, merged in alongside the profile
  assert.ok(mock.calls.some((c) => c.url.includes("ResolveVanityURL")));
  assert.ok(mock.calls.some((c) => c.url.includes("GetPlayerSummaries")));
  assert.ok(mock.calls.some((c) => c.url.includes("GetSteamLevel")));
});

test("get_player_bans reports ban status by steamid", async (t) => {
  installFetch(t, mockFetch(router));
  const { client, close } = await connectServer(ENV);
  t.after(close);
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

test("player tools error clearly when steamid is omitted and STEAM_ID is unset", async (t) => {
  installFetch(t, mockFetch(router));
  const { client, close } = await connectServer(ENV); // key set, but no STEAM_ID
  t.after(close);
  const res = await client.callTool({ name: "get_player_summary", arguments: {} });
  assert.equal(res.isError, true);
  assert.match((res.content as { text: string }[])[0]!.text, /STEAM_ID/);
});
