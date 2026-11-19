// Zod schemas for format/webAchievements.ts's summarizers (the three
// achievement-list tools: get_player_achievements, get_global_achievements,
// get_game_achievements). Co-located with their shapers, mirroring the
// storefront/web/store/shared split — each summarizer builds its return value
// via `schema.parse({...})`, so the schema is the single source of truth for
// its shape. `z.strictObject()` throughout.
import { z } from "zod";
import { unchecked } from "./shared.ts";

// The `game` caveat below is the same one getGameAchievementsOutput carries:
// both fields are populated from Valve's achievement schema (playerstats.gameName
// / game.gameName), so they hit the identical codename case. Warned in one place
// only was a disclosure gap, not a difference in behavior.
export const playerAchievementsFound = z.strictObject({
  found: z.literal(true),
  game: z
    .string()
    .nullable()
    .describe(
      "The game's name from Valve's achievement schema — occasionally an internal dev " +
        "codename rather than the store title (e.g. 'Fiber' for Persona 5 Royal). Treat the " +
        "appid you passed as the reliable identifier, or get the store title from get_game.",
    ),
  total: z.number(),
  unlocked: z.number(),
  completion_pct: z.number().nullable(),
  returned: z.number(),
  achievements: z.array(
    z.strictObject({
      name: z
        .string()
        .optional()
        .describe(
          "Display name, falling back to the achievement's internal api name when Valve's " +
            "schema has no localized title for it.",
        ),
      achieved: z.boolean(),
      unlocked_at: z.string().nullable(),
    }),
  ),
});

export const getGlobalAchievementsOutput = z.strictObject({
  count: z.number(),
  returned: z.number(),
  achievements: z.array(
    z.strictObject({ name: z.string().optional(), percent: z.number().nullable() }),
  ),
});

export const getGameAchievementsOutput = z.strictObject({
  game: z
    .string()
    .nullable()
    .describe(
      "The game's name from Valve's achievement schema — occasionally an internal dev " +
        "codename rather than the store title (e.g. 'Fiber' for Persona 5 Royal). Treat the " +
        "appid you passed as the reliable identifier, or get the store title from get_game.",
    ),
  total: z.number(),
  returned: z.number(),
  achievements: z.array(
    z.strictObject({
      api_name: z.string().optional(),
      name: z.string().nullable(),
      description: z.string().nullable(),
      hidden: z.boolean(),
      global_unlock_pct: z.number().nullable(),
    }),
  ),
});

// ---- Steam's answers (input) -------------------------------------------------
// Body rules, as in web.schemas.ts: the response types in webAchievements.ts
// are inferred from these. Only the required fields are checked.

interface PlayerAchievement {
  apiname?: string;
  name?: string;
  achieved?: number;
  unlocktime?: number;
}
export const playerAchievementsInput = z.looseObject({
  playerstats: z.looseObject({
    success: z.boolean(),
    error: unchecked<string>().optional(),
    gameName: unchecked<string>().optional(),
    achievements: unchecked<PlayerAchievement[]>().optional(),
  }),
});

interface GlobalAchievement {
  name?: string;
  percent?: number | string;
}
export const globalAchievementsInput = z.looseObject({
  achievementpercentages: z.looseObject({ achievements: z.array(unchecked<GlobalAchievement>()) }),
});

interface GameStats {
  achievements?: {
    name?: string; // internal apiname
    displayName?: string;
    description?: string;
    hidden?: number;
    icon?: string;
  }[];
}
export const gameSchemaInput = z.looseObject({
  game: z.looseObject({
    gameName: unchecked<string>().optional(),
    availableGameStats: unchecked<GameStats>().optional(),
  }),
});
