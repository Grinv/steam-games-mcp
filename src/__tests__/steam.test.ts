import { test } from "node:test";
import assert from "node:assert/strict";
import { connectServer, installFetch, mockFetch, jsonResponse } from "./helpers.js";

// Key present + throttling disabled so tests run offline and fast.
const ENV = {
  STEAM_API_KEY: "test-key",
  STEAM_STORE_MIN_INTERVAL_MS: "0",
  STEAM_API_MIN_INTERVAL_MS: "0",
};

const APP = {
  name: "Portal 2",
  steam_appid: 620,
  type: "game",
  is_free: false,
  short_description: "A puzzle game.",
  price_overview: {
    currency: "USD",
    initial: 999,
    final: 199,
    discount_percent: 80,
    initial_formatted: "$9.99",
    final_formatted: "$1.99",
  },
  genres: [{ id: "1", description: "Action" }],
  categories: [{ id: 2, description: "Single-player" }],
  platforms: { windows: true, mac: false, linux: true },
  release_date: { coming_soon: false, date: "21 Apr, 2011" },
  metacritic: { score: 95, url: "https://www.metacritic.com/game/pc/portal-2" },
  developers: ["Valve"],
  publishers: ["Valve"],
  recommendations: { total: 1000 },
  controller_support: "full",
  achievements: { total: 51 },
  dlc: [12345],
  supported_languages: "English<strong>*</strong>, French",
  content_descriptors: { ids: [2, 5], notes: null },
};

const SEARCH = { total: 1, items: [{ type: "app", name: "Portal 2", id: 620, metascore: "95" }] };
const REVIEWS = {
  success: 1,
  query_summary: {
    review_score_desc: "Overwhelmingly Positive",
    total_positive: 90,
    total_negative: 10,
    total_reviews: 100,
  },
  reviews: [{ review: "Great", voted_up: true, votes_up: 5, author: { playtime_forever: 600 } }],
};
const FEATURED = {
  specials: {
    items: [
      {
        id: 620,
        name: "Portal 2",
        discounted: true,
        discount_percent: 80,
        original_price: 999,
        final_price: 199,
        currency: "USD",
      },
    ],
  },
  top_sellers: { items: [] },
};
const NEWS = {
  appnews: {
    newsitems: [
      {
        title: "Update",
        date: 1700000000,
        author: "Valve",
        contents: "<b>notes</b>",
        url: "http://x",
      },
    ],
  },
};
const GLOBAL = { achievementpercentages: { achievements: [{ name: "ACH_X", percent: "74.2" }] } };
const PLAYERS = {
  response: {
    players: [
      {
        steamid: "76561197960287930",
        personaname: "Rabscuttle",
        personastate: 1,
        communityvisibilitystate: 3,
        profileurl: "http://p",
      },
    ],
  },
};
const OWNED = {
  response: {
    game_count: 2,
    games: [
      { appid: 620, name: "Portal 2", playtime_forever: 600 },
      { appid: 400, name: "Portal", playtime_forever: 1200 },
    ],
  },
};
const ACHIEVEMENTS = {
  playerstats: {
    success: true,
    gameName: "Portal 2",
    achievements: [
      { apiname: "A", name: "First", achieved: 1, unlocktime: 1700000000 },
      { apiname: "B", name: "Second", achieved: 0 },
    ],
  },
};
const VANITY = { response: { success: 1, steamid: "76561197960287930" } };
const CURRENT_PLAYERS = { response: { player_count: 12345, result: 1 } };
const HISTOGRAM = {
  success: 1,
  results: {
    rollup_type: "month",
    rollups: [{ date: 1301616000, recommendations_up: 754, recommendations_down: 1 }],
    recent: [{ date: 1780185600, recommendations_up: 66, recommendations_down: 2 }],
  },
};
const WISHLIST = {
  response: {
    items: [
      { appid: 660, priority: 2, date_added: 1397058887 },
      { appid: 620, priority: 1, date_added: 1400000000 },
    ],
  },
};

function router(url: string) {
  if (url.includes("/api/storesearch")) return jsonResponse(SEARCH);
  if (url.includes("/api/appdetails")) {
    const id = /appids=(\d+)/.exec(url)?.[1] ?? "620";
    return jsonResponse({ [id]: { success: true, data: APP } });
  }
  if (url.includes("/appreviewhistogram/")) return jsonResponse(HISTOGRAM);
  if (url.includes("/appreviews/")) return jsonResponse(REVIEWS);
  if (url.includes("/api/featuredcategories")) return jsonResponse(FEATURED);
  if (url.includes("GetNewsForApp")) return jsonResponse(NEWS);
  if (url.includes("GetGlobalAchievementPercentagesForApp")) return jsonResponse(GLOBAL);
  if (url.includes("GetNumberOfCurrentPlayers")) return jsonResponse(CURRENT_PLAYERS);
  if (url.includes("GetWishlist")) return jsonResponse(WISHLIST);
  if (url.includes("GetPlayerSummaries")) return jsonResponse(PLAYERS);
  if (url.includes("GetOwnedGames")) return jsonResponse(OWNED);
  if (url.includes("GetRecentlyPlayedGames")) return jsonResponse(OWNED);
  if (url.includes("GetPlayerAchievements")) return jsonResponse(ACHIEVEMENTS);
  if (url.includes("ResolveVanityURL")) return jsonResponse(VANITY);
  return jsonResponse({});
}

test("the server advertises store and player tools", async () => {
  const { client, close } = await connectServer(ENV);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of [
      "search_games",
      "get_game",
      "get_specials",
      "get_player_summary",
      "resolve_vanity_url",
    ]) {
      assert.ok(names.includes(t), `missing ${t}`);
    }
  } finally {
    await close();
  }
});

test("search_games returns appids", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({ name: "search_games", arguments: { term: "portal" } });
    const s = res.structuredContent as { results: { appid: number; name: string }[] };
    assert.equal(s.results[0]!.appid, 620);
    assert.equal(s.results[0]!.name, "Portal 2");
  } finally {
    restore();
    await close();
  }
});

test("get_game shapes price, platforms and metacritic", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({ name: "get_game", arguments: { appid: 620 } });
    const s = res.structuredContent as {
      appid: number;
      price: { final: string; discount_percent: number };
      platforms: string[];
      metacritic: number;
      genres: string[];
      controller_support: string;
      achievements_total: number;
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
    assert.deepEqual(s.dlc, [12345]);
    assert.equal(s.supported_languages, "English * , French"); // HTML stripped
    assert.deepEqual(s.content_descriptors.ids, [2, 5]);
  } finally {
    restore();
    await close();
  }
});

test("get_game returns a not-found error for an unknown app", async () => {
  const restore = installFetch(
    mockFetch((url) => {
      if (url.includes("/api/appdetails")) return jsonResponse({ "999": { success: false } });
      return jsonResponse({});
    }),
  );
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({ name: "get_game", arguments: { appid: 999 } });
    assert.equal(res.isError, true);
  } finally {
    restore();
    await close();
  }
});

test("get_game_reviews summarizes score and percentage", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({ name: "get_game_reviews", arguments: { appid: 620 } });
    const s = res.structuredContent as { summary: string; positive_pct: number };
    assert.equal(s.summary, "Overwhelmingly Positive");
    assert.equal(s.positive_pct, 90);
  } finally {
    restore();
    await close();
  }
});

test("get_specials lists discounted games with formatted prices", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({ name: "get_specials", arguments: {} });
    const s = res.structuredContent as {
      specials: { final_price: string; discount_percent: number }[];
    };
    assert.equal(s.specials[0]!.discount_percent, 80);
    assert.equal(s.specials[0]!.final_price, "1.99 USD");
  } finally {
    restore();
    await close();
  }
});

test("get_game_news works without a key", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer({
    STEAM_STORE_MIN_INTERVAL_MS: "0",
    STEAM_API_MIN_INTERVAL_MS: "0",
  });
  try {
    const res = await client.callTool({ name: "get_game_news", arguments: { appid: 620 } });
    const s = res.structuredContent as { items: { title: string; excerpt: string }[] };
    assert.equal(s.items[0]!.title, "Update");
    assert.equal(s.items[0]!.excerpt, "notes"); // HTML stripped
  } finally {
    restore();
    await close();
  }
});

test("get_global_achievements parses percentages as numbers", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "get_global_achievements",
      arguments: { appid: 620 },
    });
    const s = res.structuredContent as { count: number; achievements: { percent: number }[] };
    assert.equal(s.count, 1);
    assert.equal(s.achievements[0]!.percent, 74.2);
  } finally {
    restore();
    await close();
  }
});

test("player tools error clearly without STEAM_API_KEY", async () => {
  const { client, close } = await connectServer({});
  try {
    const res = await client.callTool({
      name: "get_owned_games",
      arguments: { steamid: "76561197960287930" },
    });
    assert.equal(res.isError, true);
    const text = (res.content as { text: string }[])[0]!.text;
    assert.match(text, /STEAM_API_KEY/);
  } finally {
    await close();
  }
});

test("get_owned_games sorts by playtime and converts to hours", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
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
  } finally {
    restore();
    await close();
  }
});

test("get_player_achievements computes completion", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "get_player_achievements",
      arguments: { steamid: "76561197960287930", appid: 620 },
    });
    const s = res.structuredContent as { total: number; unlocked: number; completion_pct: number };
    assert.equal(s.total, 2);
    assert.equal(s.unlocked, 1);
    assert.equal(s.completion_pct, 50);
  } finally {
    restore();
    await close();
  }
});

test("resolve_vanity_url returns the steamid", async () => {
  const mock = mockFetch(router);
  const restore = installFetch(mock);
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "resolve_vanity_url",
      arguments: { vanity: "gabe" },
    });
    const s = res.structuredContent as { found: boolean; steamid: string };
    assert.equal(s.found, true);
    assert.equal(s.steamid, "76561197960287930");
    assert.ok(mock.calls.some((c) => c.url.includes("key=test-key")));
  } finally {
    restore();
    await close();
  }
});

test("get_current_players works without a key and returns the count", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer({ STEAM_API_MIN_INTERVAL_MS: "0" });
  try {
    const res = await client.callTool({ name: "get_current_players", arguments: { appid: 730 } });
    const s = res.structuredContent as { appid: number; player_count: number };
    assert.equal(s.appid, 730);
    assert.equal(s.player_count, 12345);
  } finally {
    restore();
    await close();
  }
});

test("get_review_histogram returns history and recent with positive %", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer({ STEAM_STORE_MIN_INTERVAL_MS: "0" });
  try {
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
  } finally {
    restore();
    await close();
  }
});

test("get_wishlist sorts by priority (no key) and reports private as not-found", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer({ STEAM_API_MIN_INTERVAL_MS: "0" });
  try {
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
  } finally {
    restore();
    await close();
  }
});

test("get_wishlist returns found:false when empty/private", async () => {
  const restore = installFetch(
    mockFetch((url) =>
      url.includes("GetWishlist") ? jsonResponse({ response: {} }) : jsonResponse({}),
    ),
  );
  const { client, close } = await connectServer({ STEAM_API_MIN_INTERVAL_MS: "0" });
  try {
    const res = await client.callTool({
      name: "get_wishlist",
      arguments: { steamid: "76561197960287930" },
    });
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.match(s.reason, /private/);
  } finally {
    restore();
    await close();
  }
});
