// Shared mock-upstream fixtures for the split integration suites
// (steamStorefront.test.ts, steamCatalog.test.ts, steamPlayer.test.ts) — one
// `router()` covering every endpoint those three files exercise, so a single
// connectServer() + installFetch(t, mockFetch(router)) setup works everywhere.
import { jsonResponse } from "./helpers.js";

// Key present + throttling disabled so tests run offline and fast.
export const ENV = {
  STEAM_API_KEY: "test-key",
  STEAM_STORE_MIN_INTERVAL_MS: "0",
  STEAM_API_MIN_INTERVAL_MS: "0",
};

export const APP = {
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
  achievements: { total: 51, highlighted: [{ name: "Wake Up Call", path: "x.jpg" }] },
  dlc: [12345],
  supported_languages: "English<strong>*</strong>, French",
  content_descriptors: { ids: [2, 5], notes: null },
};

export const SEARCH = {
  total: 1,
  items: [{ type: "app", name: "Portal 2", id: 620, metascore: "95" }],
};
export const REVIEWS = {
  success: 1,
  query_summary: {
    review_score_desc: "Overwhelmingly Positive",
    total_positive: 90,
    total_negative: 10,
    total_reviews: 100,
  },
  reviews: [{ review: "Great", voted_up: true, votes_up: 5, author: { playtime_forever: 600 } }],
};
export const FEATURED = {
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
      // Steam's own featuredcategories endpoint repeats appids within a
      // section (confirmed live) — this duplicate proves we dedupe it.
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
export const NEWS = {
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
export const GLOBAL = {
  achievementpercentages: { achievements: [{ name: "ACH_X", percent: "74.2" }] },
};
export const SCHEMA = {
  game: {
    gameName: "Portal 2",
    availableGameStats: {
      achievements: [
        { name: "ACH_X", displayName: "Wake Up Call", description: "Survive.", hidden: 0 },
        { name: "ACH_Y", displayName: "Hidden One", description: "", hidden: 1 },
      ],
    },
  },
};
export const PLAYERS = {
  response: {
    players: [
      {
        steamid: "76561197960287930",
        personaname: "Rabscuttle",
        personastate: 1,
        communityvisibilitystate: 3,
        profileurl: "http://p",
      },
      {
        steamid: "76561197960287931",
        personaname: "Two Socks",
        personastate: 0,
        communityvisibilitystate: 3,
        profileurl: "http://p2",
      },
    ],
  },
};
export const FRIENDLIST = {
  friendslist: {
    friends: [
      { steamid: "76561197960287930", relationship: "friend", friend_since: 1600000000 },
      { steamid: "76561197960287931", relationship: "friend", friend_since: 1650000000 },
    ],
  },
};
export const OWNED = {
  response: {
    game_count: 2,
    games: [
      { appid: 620, name: "Portal 2", playtime_forever: 600 },
      { appid: 400, name: "Portal", playtime_forever: 1200 },
    ],
  },
};
export const ACHIEVEMENTS = {
  playerstats: {
    success: true,
    gameName: "Portal 2",
    achievements: [
      { apiname: "A", name: "First", achieved: 1, unlocktime: 1700000000 },
      { apiname: "B", name: "Second", achieved: 0 },
    ],
  },
};
export const VANITY = { response: { success: 1, steamid: "76561197960287930" } };
export const CURRENT_PLAYERS = { response: { player_count: 12345, result: 1 } };
export const HISTOGRAM = {
  success: 1,
  results: {
    rollup_type: "month",
    rollups: [{ date: 1301616000, recommendations_up: 754, recommendations_down: 1 }],
    recent: [{ date: 1780185600, recommendations_up: 66, recommendations_down: 2 }],
  },
};
export const WISHLIST = {
  response: {
    items: [
      { appid: 660, priority: 2, date_added: 1397058887 },
      { appid: 620, priority: 1, date_added: 1400000000 },
    ],
  },
};
export const STEAM_LEVEL = { response: { player_level: 42 } };
export const PLAYER_BANS = {
  players: [
    {
      SteamId: "76561197960287930",
      CommunityBanned: false,
      VACBanned: true,
      NumberOfVACBans: 1,
      NumberOfGameBans: 0,
      DaysSinceLastBan: 100,
      EconomyBan: "none",
    },
  ],
};
export const FOLLOWED = { response: { appids: [620, 400] } };
export const FOLLOWED_COUNT = { response: { followed_game_count: 2 } };

// GetWishlistSortedFiltered: each entry embeds a full store_item card. 620 is on
// sale (80%); 660 is full price — so on_sale_only keeps only 620.
export const WISHLIST_DETAILED = {
  response: {
    items: [
      {
        appid: 660,
        priority: 2,
        date_added: 1397058887,
        store_item: {
          appid: 660,
          name: "Full Price Game",
          best_purchase_option: { discount_pct: 0, formatted_final_price: "$19.99" },
          reviews: { summary_filtered: { percent_positive: 80, review_count: 500 } },
          platforms: {
            windows: true,
            steam_deck_compat_category: 2,
            steam_os_compat_category: 1,
            steam_machine_compat_category: 1,
          },
          tags: [{ tagid: 30, weight: 700 }],
          release: { steam_release_date: 1400000000 },
        },
      },
      {
        appid: 620,
        priority: 1,
        date_added: 1400000000,
        store_item: {
          appid: 620,
          name: "Portal 2",
          best_purchase_option: {
            discount_pct: 80,
            formatted_final_price: "$1.99",
            formatted_original_price: "$9.99",
          },
          reviews: { summary_filtered: { percent_positive: 98, review_count: 1000 } },
          platforms: {
            windows: true,
            steam_deck_compat_category: 3,
            steam_os_compat_category: 2,
            steam_machine_compat_category: 2,
          },
          tags: [{ tagid: 10, weight: 900 }],
          release: { steam_release_date: 1303186800 },
        },
      },
    ],
  },
};

export const ITEMS = {
  response: {
    store_items: [
      {
        appid: 620,
        name: "Portal 2",
        is_free: false,
        best_purchase_option: {
          formatted_final_price: "$1.99",
          formatted_original_price: "$9.99",
          discount_pct: 80,
          active_discounts: [{ discount_end_date: 1783616400 }],
        },
        reviews: {
          summary_filtered: {
            review_count: 1000,
            percent_positive: 98,
            review_score_label: "Overwhelmingly Positive",
          },
        },
        platforms: {
          windows: true,
          steam_deck_compat_category: 3,
          steam_os_compat_category: 2,
          steam_machine_compat_category: 1,
          steam_frame_compat_category: 0,
        },
        tags: [
          { tagid: 10, weight: 900 },
          { tagid: 20, weight: 500 },
        ],
        release: { steam_release_date: 1303186800, is_coming_soon: false },
      },
    ],
  },
};

export const DISCOVER = {
  response: {
    metadata: { total_matching_records: 14132, start: 0, count: 3 },
    store_items: [
      {
        appid: 620,
        name: "Portal 2",
        visible: true,
        best_purchase_option: {
          discount_pct: 80,
          formatted_final_price: "$1.99",
          formatted_original_price: "$9.99",
          active_discounts: [{ discount_end_date: 1783616400 }],
        },
        reviews: { summary_filtered: { percent_positive: 98, review_count: 1000 } },
        platforms: {
          windows: true,
          steamos_linux: true,
          steam_deck_compat_category: 3,
          steam_os_compat_category: 2,
          steam_machine_compat_category: 2,
          steam_frame_compat_category: 0,
        },
        tags: [
          { tagid: 10, weight: 900 },
          { tagid: 20, weight: 500 },
        ],
        release: { steam_release_date: 1303186800 },
      },
      {
        appid: 999,
        name: "Shovelware",
        visible: true,
        best_purchase_option: { discount_pct: 90, formatted_final_price: "$0.10" },
        reviews: { summary_filtered: { percent_positive: 40, review_count: 5 } },
        platforms: {
          windows: true,
          steam_deck_compat_category: 1,
          steam_os_compat_category: 1,
          steam_machine_compat_category: 1,
          steam_frame_compat_category: 0,
        },
        tags: [{ tagid: 50, weight: 100 }],
      },
      { appid: 111, name: "Hidden", visible: false },
    ],
  },
};

export const TAGLIST = {
  response: {
    version_hash: "test-hash",
    tags: [
      { tagid: 10, name: "Puzzle" },
      { tagid: 20, name: "Co-op" },
      { tagid: 30, name: "Action Roguelike" },
      { tagid: 40, name: "Deckbuilding" },
      { tagid: 50, name: "Shooter" },
    ],
  },
};

export function router(url: string) {
  if (url.includes("IStoreService/GetTagList")) return jsonResponse(TAGLIST);
  if (url.includes("IStoreQueryService/Query")) return jsonResponse(DISCOVER);
  if (url.includes("IStoreBrowseService/GetItems")) return jsonResponse(ITEMS);
  if (url.includes("/api/storesearch")) return jsonResponse(SEARCH);
  if (url.includes("/api/appdetails")) {
    const id = /appids=(\d+)/.exec(url)?.[1] ?? "620";
    return jsonResponse({ [id]: { success: true, data: APP } });
  }
  if (url.includes("/appreviewhistogram/")) return jsonResponse(HISTOGRAM);
  if (url.includes("/appreviews/")) return jsonResponse(REVIEWS);
  if (url.includes("/api/featuredcategories")) return jsonResponse(FEATURED);
  if (url.includes("GetNewsForApp")) return jsonResponse(NEWS);
  if (url.includes("GetSchemaForGame")) return jsonResponse(SCHEMA);
  if (url.includes("GetGlobalAchievementPercentagesForApp")) return jsonResponse(GLOBAL);
  if (url.includes("GetNumberOfCurrentPlayers")) return jsonResponse(CURRENT_PLAYERS);
  if (url.includes("GetWishlistSortedFiltered")) return jsonResponse(WISHLIST_DETAILED);
  if (url.includes("GetWishlist")) return jsonResponse(WISHLIST);
  if (url.includes("GetGamesFollowedCount")) return jsonResponse(FOLLOWED_COUNT);
  if (url.includes("GetGamesFollowed")) return jsonResponse(FOLLOWED);
  if (url.includes("GetFriendList")) return jsonResponse(FRIENDLIST);
  if (url.includes("GetPlayerSummaries")) return jsonResponse(PLAYERS);
  if (url.includes("GetSteamLevel")) return jsonResponse(STEAM_LEVEL);
  if (url.includes("GetPlayerBans")) return jsonResponse(PLAYER_BANS);
  if (url.includes("GetOwnedGames")) return jsonResponse(OWNED);
  if (url.includes("GetRecentlyPlayedGames")) return jsonResponse(OWNED);
  if (url.includes("GetPlayerAchievements")) return jsonResponse(ACHIEVEMENTS);
  if (url.includes("ResolveVanityURL")) return jsonResponse(VANITY);
  return jsonResponse({});
}

// A GetTagList outage must not make a `tags` filter silently return zero
// matches — it should surface as an actionable error instead (steamCatalog.test.ts).
export function routerWithBrokenTagList(url: string) {
  if (url.includes("IStoreService/GetTagList")) return jsonResponse({}, { status: 500 });
  return router(url);
}
