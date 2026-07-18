import { test } from "node:test";
import assert from "node:assert/strict";
import { detailApp, summarizeReviews, summarizeSearch } from "../format/storefront.js";
import {
  summarizePlayer,
  summarizeGlobalAchievements,
  summarizeOwnedGames,
} from "../format/web.js";

// Steam frequently omits optional fields; these exercise the sparse-payload
// fallbacks (?? null / || null / ?? []) so a thin upstream response degrades
// gracefully instead of crashing or emitting undefined.

test("detailApp: a near-empty app yields null/[] fallbacks, never throws", () => {
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

test("detailApp: free DLC populates is_free price, base_game and stripped requirements", () => {
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

test("summarizeSearch: empty response → total 0, no results", () => {
  const s = summarizeSearch({}) as { total: number; results: unknown[] };
  assert.equal(s.total, 0);
  assert.deepEqual(s.results, []);
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

test("summarizeOwnedGames: checkAppids reliably reports ownership past the top-50 cap", () => {
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

test("summarizeOwnedGames: checkAppids on a private profile reports every appid as not owned", () => {
  const s = summarizeOwnedGames({ response: {} }, { checkAppids: [620, 730] }) as {
    found: boolean;
    owns: { appid: number; owned: boolean }[];
  };
  assert.equal(s.found, false);
  assert.deepEqual(s.owns, [
    { appid: 620, owned: false },
    { appid: 730, owned: false },
  ]);
});

test("summarizeGlobalAchievements: string percents are coerced to numbers", () => {
  const s = summarizeGlobalAchievements({
    achievementpercentages: { achievements: [{ name: "A", percent: "74.2" }] },
  }) as { count: number; achievements: { percent: number }[] };
  assert.equal(s.count, 1);
  assert.equal(s.achievements[0]!.percent, 74.2);
});
