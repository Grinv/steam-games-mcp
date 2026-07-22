import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  detailApp,
  summarizeReviews,
  summarizeReviewHistogram,
  summarizeSearch,
} from "../format/storefront.js";
import {
  summarizePlayer,
  summarizeGlobalAchievements,
  summarizeGameSchema,
  summarizePlayerAchievements,
  summarizeOwnedGames,
  summarizeNews,
  ACHIEVEMENTS_MAX,
} from "../format/web.js";

// Steam frequently omits optional fields; these exercise the sparse-payload
// fallbacks (?? null / || null / ?? []) so a thin upstream response degrades
// gracefully instead of crashing or emitting undefined.

describe("detailApp", () => {
  test("a near-empty app yields null/[] fallbacks, never throws", () => {
    const d = detailApp({}) as Record<string, unknown>;
    assert.equal(d.price, null);
    assert.deepEqual(d.platforms, []);
    assert.deepEqual(d.genres, []);
    assert.deepEqual(d.dlc, []);
    assert.equal(d.base_game, null);
    assert.equal(d.pc_requirements_min, null);
    assert.equal(d.store_url, null); // no appid → no link
    assert.equal(d.metacritic, null);
    assert.deepEqual(d.content_descriptors, { ids: [], notes: null });
  });

  test("free DLC populates is_free price, base_game and stripped requirements", () => {
    const d = detailApp({
      steam_appid: 5,
      name: "Some DLC",
      is_free: true,
      pc_requirements: { minimum: "<b>Windows 10</b>" },
      fullgame: { appid: "10", name: "Base Game" },
    }) as Record<string, unknown>;
    assert.deepEqual(d.price, { is_free: true });
    assert.deepEqual(d.base_game, { appid: 10, name: "Base Game" });
    assert.equal(d.pc_requirements_min, "Windows 10"); // HTML stripped
    assert.equal(d.store_url, "https://store.steampowered.com/app/5");
  });

  test("pc_requirements as [] (Steam's shape for Mac/Linux-only titles) → null, not thrown", () => {
    // detailApp special-cases Array.isArray(pc_requirements) since Steam sends
    // `[]` instead of omitting the field entirely for some platform-only titles.
    const d = detailApp({ pc_requirements: [] }) as Record<string, unknown>;
    assert.equal(d.pc_requirements_min, null);
  });

  test("required_age as a string (Steam sends both shapes) passes through as-is", () => {
    const d = detailApp({ required_age: "18" }) as Record<string, unknown>;
    assert.equal(d.required_age, "18");
    const n = detailApp({ required_age: 18 }) as Record<string, unknown>;
    assert.equal(n.required_age, 18);
  });

  test("demos: keeps a real appid of 0, only drops entries with no appid at all", () => {
    // Regression: `.filter(Boolean)` on a list of appids drops a falsy-but-valid
    // 0 alongside genuinely missing ones — a real type predicate must not.
    const d = detailApp({ demos: [{ appid: 0 }, {}, { appid: 5 }] }) as Record<string, unknown>;
    assert.deepEqual(d.demos, [0, 5]);
  });

  test("initial_formatted empty (no discount) falls back to final_formatted", () => {
    // Comment in format/storefront.ts: "Steam leaves initial_formatted empty
    // when there's no discount" — formattedPrice() must fall back to final.
    const d = detailApp({
      price_overview: {
        currency: "USD",
        final: 999,
        discount_percent: 0,
        initial_formatted: "",
        final_formatted: "$9.99",
      },
    }) as { price: { initial: string; final: string; discount_percent: number } };
    assert.equal(d.price.initial, "$9.99");
    assert.equal(d.price.final, "$9.99");
    assert.equal(d.price.discount_percent, 0);
  });
});

describe("summarizeSearch", () => {
  test("derives discount from raw cents, and a same-price item has no discount", () => {
    const s = summarizeSearch({
      items: [
        { id: 1, name: "On sale", price: { currency: "USD", initial: 1000, final: 500 } },
        { id: 2, name: "Full price", price: { currency: "USD", initial: 500, final: 500 } },
      ],
    }) as { results: { price: { discount_percent: number; final: string; initial: string } }[] };
    assert.equal(s.results[0]!.price.discount_percent, 50);
    assert.equal(s.results[0]!.price.final, "5.00 USD");
    assert.equal(s.results[1]!.price.discount_percent, 0);
  });

  test("empty response → total 0, no results", () => {
    const s = summarizeSearch({}) as { total: number; results: unknown[] };
    assert.equal(s.total, 0);
    assert.deepEqual(s.results, []);
  });
});

describe("summarizeReviewHistogram", () => {
  test("caps history to the last 24 and recent to the last 30 entries", () => {
    const rollups = Array.from({ length: 30 }, (_, i) => ({
      date: 1700000000 + i,
      recommendations_up: i,
      recommendations_down: 0,
    }));
    const recent = Array.from({ length: 40 }, (_, i) => ({
      date: 1700000000 + i,
      recommendations_up: i,
      recommendations_down: 0,
    }));
    const s = summarizeReviewHistogram({
      results: { rollup_type: "month", rollups, recent },
    }) as { history: { date: string }[]; recent: { date: string }[] };
    assert.equal(s.history.length, 24);
    assert.equal(s.recent.length, 30);
    // The cap keeps the MOST RECENT entries (a tail slice), not the earliest.
    assert.equal(s.history[0]!.date, new Date((1700000000 + 6) * 1000).toISOString().slice(0, 10));
    assert.equal(s.recent[0]!.date, new Date((1700000000 + 10) * 1000).toISOString().slice(0, 10));
  });

  test("a zero-total rollup (0 up, 0 down) reports positive_pct null, not 0", () => {
    const s = summarizeReviewHistogram({
      results: { rollups: [{ date: 1700000000, recommendations_up: 0, recommendations_down: 0 }] },
    }) as { history: { positive_pct: number | null }[] };
    assert.equal(s.history[0]!.positive_pct, null);
  });
});

test("summarizeReviews: empty payload → null summary and no reviews; long text is truncated", () => {
  const empty = summarizeReviews({}) as Record<string, unknown>;
  assert.equal(empty.summary, null);
  assert.equal(empty.positive_pct, null);
  assert.deepEqual(empty.reviews, []);

  const long = "x".repeat(700);
  const s = summarizeReviews({ reviews: [{ review: long, voted_up: true }] }) as {
    reviews: { text: string }[];
  };
  assert.equal(s.reviews[0]!.text.length, 601); // 600 chars + ellipsis
  assert.ok(s.reviews[0]!.text.endsWith("…"));
});

test("summarizePlayer: no players → found:false; sparse player fills nullable fields", () => {
  assert.deepEqual(summarizePlayer({ response: { players: [] } }), { found: false });
  const p = summarizePlayer({
    response: { players: [{ steamid: "1", personaname: "Solo" }] },
  }) as Record<string, unknown>;
  assert.equal(p.found, true);
  assert.equal(p.state, "offline"); // no personastate → default index 0
  assert.equal(p.visibility, "private"); // communityvisibilitystate !== 3
  assert.equal(p.country, null);
  assert.equal(p.created, null);
  assert.equal(p.in_game, null);
});

describe("summarizeOwnedGames", () => {
  test("checkAppids reliably reports ownership past the top-50 cap", () => {
    // A 51st-most-played game (appid 999) would fall outside `games` (capped to
    // `max`), but checkAppids must still see it via the FULL list.
    const games: { appid: number; name?: string; playtime_forever: number }[] = [
      { appid: 1, name: "Top", playtime_forever: 1000 },
    ];
    for (let i = 2; i <= 51; i++) games.push({ appid: i, playtime_forever: 51 - i });
    games.push({ appid: 999, playtime_forever: 3 }); // owned, but low playtime
    const r = { response: { game_count: games.length, games } };
    const s = summarizeOwnedGames(r, { max: 1, checkAppids: [999, 1, 12345] }) as {
      returned: number;
      owns: { appid: number; owned: boolean; playtime_hours: number | null }[];
    };
    assert.equal(s.returned, 1); // `games` itself still respects the cap
    assert.deepEqual(s.owns, [
      { appid: 999, owned: true, playtime_hours: 0.1 }, // 3 min → 0.1h
      { appid: 1, owned: true, playtime_hours: 16.7 }, // 1000 min → 16.7h
      { appid: 12345, owned: false, playtime_hours: null },
    ]);
  });

  test("checkAppids on a private profile omits owns — unknown, not falsely reported as not owned", () => {
    const s = summarizeOwnedGames({ response: {} }, { checkAppids: [620, 730] }) as {
      found: boolean;
      owns?: { appid: number; owned: boolean }[];
    };
    assert.equal(s.found, false);
    assert.equal(s.owns, undefined);
  });
});

test("summarizeNews: no news items (brand-new game) → empty items, not thrown", () => {
  const s = summarizeNews({ appnews: { newsitems: [] } }) as { items: unknown[] };
  assert.deepEqual(s.items, []);
  assert.deepEqual(summarizeNews({}), { items: [] });
});

describe("summarizeGlobalAchievements", () => {
  test("no achievements (brand-new/achievement-less game) → count 0", () => {
    const s = summarizeGlobalAchievements({ achievementpercentages: { achievements: [] } }) as {
      count: number;
      achievements: unknown[];
    };
    assert.equal(s.count, 0);
    assert.deepEqual(s.achievements, []);
  });

  test("string percents are coerced to numbers", () => {
    const s = summarizeGlobalAchievements({
      achievementpercentages: { achievements: [{ name: "A", percent: "74.2" }] },
    }) as { count: number; achievements: { percent: number }[] };
    assert.equal(s.count, 1);
    assert.equal(s.achievements[0]!.percent, 74.2);
  });

  test("a 1000+-achievement game (e.g. PAYDAY 2) is capped at 200, not returned in full", () => {
    const achievements = Array.from({ length: 1328 }, (_, i) => ({ name: `a${i}`, percent: 50 }));
    const s = summarizeGlobalAchievements({ achievementpercentages: { achievements } }) as {
      count: number;
      returned: number;
      achievements: unknown[];
    };
    assert.equal(s.count, 1328); // true total, unaffected by the cap
    assert.equal(s.returned, ACHIEVEMENTS_MAX);
    assert.equal(s.achievements.length, ACHIEVEMENTS_MAX);
  });

  test("a common-sized list (e.g. 130 achievements) is returned in full, well under the cap", () => {
    const achievements = Array.from({ length: 130 }, (_, i) => ({ name: `a${i}`, percent: 50 }));
    const s = summarizeGlobalAchievements({ achievementpercentages: { achievements } }) as {
      count: number;
      returned: number;
      achievements: unknown[];
    };
    assert.equal(s.count, 130);
    assert.equal(s.returned, 130);
    assert.equal(s.achievements.length, 130);
  });
});

describe("summarizeGameSchema", () => {
  test("a 1000+-achievement game is capped at 200 in definition order, total stays the true count", () => {
    const achievements = Array.from({ length: 1328 }, (_, i) => ({
      name: `a${i}`,
      displayName: `Achievement ${i}`,
      description: "",
      hidden: 0,
    }));
    const s = summarizeGameSchema(
      { game: { gameName: "PAYDAY 2", availableGameStats: { achievements } } },
      { achievementpercentages: { achievements: [] } },
    ) as { total: number; returned: number; achievements: { name: string }[] };
    assert.equal(s.total, 1328);
    assert.equal(s.returned, ACHIEVEMENTS_MAX);
    assert.equal(s.achievements.length, ACHIEVEMENTS_MAX);
    assert.equal(s.achievements[0]!.name, "Achievement 0"); // definition order preserved
  });

  test("a common-sized list (e.g. 130 achievements) is returned in full, well under the cap", () => {
    const achievements = Array.from({ length: 130 }, (_, i) => ({
      name: `a${i}`,
      displayName: `Achievement ${i}`,
    }));
    const s = summarizeGameSchema(
      { game: { gameName: "Some Game", availableGameStats: { achievements } } },
      { achievementpercentages: { achievements: [] } },
    ) as { total: number; returned: number; achievements: unknown[] };
    assert.equal(s.total, 130);
    assert.equal(s.returned, 130);
    assert.equal(s.achievements.length, 130);
  });
});

describe("summarizePlayerAchievements", () => {
  test("a 1000+-achievement game is capped at 200, unlocked-first, but unlocked/completion_pct stay exact", () => {
    const achievements = Array.from({ length: 1328 }, (_, i) => ({
      apiname: `a${i}`,
      achieved: i < 30 ? 1 : 0, // 30 unlocked, scattered at the front of the raw list
    }));
    const s = summarizePlayerAchievements({
      playerstats: { success: true, gameName: "PAYDAY 2", achievements },
    }) as {
      total: number;
      unlocked: number;
      completion_pct: number | null;
      returned: number;
      achievements: { achieved: boolean }[];
    };
    assert.equal(s.total, 1328); // true total, unaffected by the cap
    assert.equal(s.unlocked, 30); // true unlocked count, unaffected by the cap
    assert.equal(s.completion_pct, Math.round((30 / 1328) * 100));
    assert.equal(s.returned, ACHIEVEMENTS_MAX);
    assert.equal(s.achievements.length, ACHIEVEMENTS_MAX);
    assert.ok(s.achievements.slice(0, 30).every((a) => a.achieved)); // unlocked sorted first
  });

  test("a common-sized list (e.g. 130 achievements) is returned in full, well under the cap", () => {
    const achievements = Array.from({ length: 130 }, (_, i) => ({
      apiname: `a${i}`,
      achieved: i < 50 ? 1 : 0,
    }));
    const s = summarizePlayerAchievements({
      playerstats: { success: true, gameName: "Some Game", achievements },
    }) as { total: number; unlocked: number; returned: number; achievements: unknown[] };
    assert.equal(s.total, 130);
    assert.equal(s.unlocked, 50);
    assert.equal(s.returned, 130);
    assert.equal(s.achievements.length, 130);
  });
});
