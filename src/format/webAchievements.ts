// Achievement summarizers for the official Steam Web API — the three
// achievement-list tools (get_player_achievements, get_global_achievements,
// get_game_achievements) plus the shared cap and percent helper they all use.
// Split out of format/web.ts, which kept the rest of the Web API player-data
// summarizers, once that file grew past ~550 lines; these three are grouped
// together because they share ACHIEVEMENTS_MAX, the GlobalAchievementsResponse
// rarity data (get_game_achievements merges it into the schema), and the
// finitePercent coercion.
import { z } from "zod";
import { capList, isoDay, notFound } from "./shared.js";
import { notFoundReason } from "./shared.schemas.js";
import {
  getGameAchievementsOutput,
  getGlobalAchievementsOutput,
  playerAchievementsFound,
} from "./web.schemas.js";

// ---- Web API: player achievements -------------------------------------------

export interface PlayerAchievementsResponse {
  playerstats?: {
    success?: boolean;
    error?: string;
    gameName?: string;
    achievements?: { apiname?: string; name?: string; achieved?: number; unlocktime?: number }[];
  };
}

// Shared cap for all three achievement-list tools (get_player_achievements,
// get_global_achievements, get_game_achievements) — a handful of long-running
// live-service games (e.g. PAYDAY 2's 1,328) ship achievement counts an order
// of magnitude past the common case (~120-130), and an uncapped list from one
// of those blows past the response size limit entirely.
export const ACHIEVEMENTS_MAX = 200;

export function summarizePlayerAchievements(
  r: PlayerAchievementsResponse,
  max = ACHIEVEMENTS_MAX,
): z.infer<typeof notFoundReason> | z.infer<typeof playerAchievementsFound> {
  const ps = r.playerstats;
  if (!ps?.success) {
    return notFound(ps?.error ?? "No achievement stats");
  }
  const all = ps.achievements ?? [];
  const unlocked = all.filter((a) => a.achieved === 1);
  // Some games (e.g. long-running live-service titles) ship 1000+ achievements
  // — unbounded, the full list can blow past the response token cap. `total`/
  // `unlocked`/`completion_pct` above already reflect the true full list; only
  // the array itself is capped, unlocked-first (more likely of interest than
  // an arbitrary slice of Steam's own achievement-definition order) — reusing
  // the `unlocked` filter already computed above, rather than an O(n log n)
  // sort over a binary achieved/not-achieved split.
  const { included, returned } = capList(
    [...unlocked, ...all.filter((a) => a.achieved !== 1)],
    max,
  );
  return playerAchievementsFound.parse({
    found: true,
    game: ps.gameName ?? null,
    total: all.length,
    unlocked: unlocked.length,
    completion_pct: all.length ? Math.round((unlocked.length / all.length) * 100) : null,
    returned,
    achievements: included.map((a) => ({
      name: a.name || a.apiname,
      achieved: a.achieved === 1,
      unlocked_at: a.achieved === 1 ? isoDay(a.unlocktime) : null,
    })),
  });
}

// ---- Web API: global achievement percentages --------------------------------

export interface GlobalAchievementsResponse {
  achievementpercentages?: { achievements?: { name?: string; percent?: number | string }[] };
}

// Steam sends `percent` as a JSON float, but the string-coercion branch below
// means a non-numeric value would become NaN — and z.number() rejects NaN
// (which is typeof "number"), throwing the whole summarizer. Coerce, then fall
// back to `fallback` when the result isn't a finite number.
function finitePercent(v: number | string | undefined, fallback: number): number;
function finitePercent(v: number | string | undefined, fallback: null): number | null;
function finitePercent(v: number | string | undefined, fallback: number | null): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

export function summarizeGlobalAchievements(
  r: GlobalAchievementsResponse,
  max = ACHIEVEMENTS_MAX,
): z.infer<typeof getGlobalAchievementsOutput> {
  // Steam already returns these sorted most-common-first; some games (e.g.
  // long-running live-service titles) ship 1000+ achievements, so the full
  // list is capped the same way summarizeOwnedGames/summarizeFriendList cap
  // theirs — `count` still reports the true total.
  const a = r.achievementpercentages?.achievements ?? [];
  const { included, returned } = capList(a, max);
  return getGlobalAchievementsOutput.parse({
    count: a.length,
    returned,
    achievements: included.map((x) => ({
      name: x.name,
      percent: finitePercent(x.percent, null),
    })),
  });
}

// ---- Web API: full achievement schema (key) + global rarity merge -----------

export interface GameSchemaResponse {
  game?: {
    gameName?: string;
    availableGameStats?: {
      achievements?: {
        name?: string; // internal apiname
        displayName?: string;
        description?: string;
        hidden?: number;
        icon?: string;
      }[];
    };
  };
}

// Merge the full schema (names/descriptions/hidden) with global unlock % (keyed
// by the internal apiname), so each achievement carries how rare it is.
export function summarizeGameSchema(
  schema: GameSchemaResponse,
  global: GlobalAchievementsResponse,
  max = ACHIEVEMENTS_MAX,
): z.infer<typeof getGameAchievementsOutput> {
  const pct = new Map<string, number>();
  for (const x of global.achievementpercentages?.achievements ?? []) {
    if (x.name != null) {
      pct.set(x.name, finitePercent(x.percent, 0));
    }
  }
  const list = schema.game?.availableGameStats?.achievements ?? [];
  // Some games (e.g. long-running live-service titles) ship 1000+
  // achievements — unbounded, the full list can blow past the response token
  // cap. Capped in the game's own definition order (unlike
  // summarizeGlobalAchievements, which is rarity-sorted); `total` still
  // reports the true full count.
  const { included, returned } = capList(list, max);
  return getGameAchievementsOutput.parse({
    game: schema.game?.gameName ?? null,
    total: list.length,
    returned,
    achievements: included.map((a) => {
      const p = a.name != null ? pct.get(a.name) : undefined;
      return {
        api_name: a.name,
        name: a.displayName || a.name || null,
        description: a.description || null,
        hidden: a.hidden === 1,
        global_unlock_pct: typeof p === "number" ? Math.round(p * 10) / 10 : null,
      };
    }),
  });
}
