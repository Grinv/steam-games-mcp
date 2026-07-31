// Zod schemas for format/webAchievements.ts's summarizers (the three
// achievement-list tools: get_player_achievements, get_global_achievements,
// get_game_achievements). Co-located with their shapers, mirroring the
// storefront/web/store/shared split — each summarizer builds its return value
// via `schema.parse({...})`, so the schema is the single source of truth for
// its shape. `z.strictObject()` throughout.
import { z } from "zod";

export const playerAchievementsFound = z.strictObject({
  found: z.literal(true),
  game: z.string().nullable(),
  total: z.number(),
  unlocked: z.number(),
  completion_pct: z.number().nullable(),
  returned: z.number(),
  achievements: z.array(
    z.strictObject({
      name: z.string().optional(),
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
