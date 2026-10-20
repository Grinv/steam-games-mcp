// Zod schema for format/charts.ts's summarizeCharts (get_charts). Schema-first,
// like every other format/*.schemas.ts: the shaper builds its return value via
// `getChartsOutput.parse({...})`, so this is the single source of truth for the
// shape and the tool's outputSchema.
import { z } from "zod";

export const CHART_NAMES = [
  "top_sellers",
  "most_played",
  "most_played_deck",
  "concurrent_players",
] as const;
export const chartSchema = z.enum(CHART_NAMES);

const base = {
  rank: z.number(),
  appid: z.number(),
  name: z.string().nullable().describe("Game name; null when Steam sends none for the entry."),
  store_url: z.string().nullable(),
};

// Not on concurrent_players: that chart is live and Steam sends no previous rank for it.
const lastWeekRank = z
  .number()
  .nullable()
  .describe("Rank one week earlier; null means the game was not on this chart then (new entry).");

const chartOf = <K extends (typeof CHART_NAMES)[number], E extends z.ZodRawShape>(
  chart: K,
  entry: E,
) =>
  z.strictObject({
    chart: z.literal(chart),
    as_of: z
      .string()
      .nullable()
      .describe(
        "ISO 8601 UTC time of the chart: start of the week (top_sellers), start of the day " +
          "the peak was measured (most_played) or last live update (concurrent_players); " +
          "null for most_played_deck, which Steam sends undated.",
      ),
    count: z.number().describe("Entries returned (at most the requested `limit`)."),
    entries: z.array(z.strictObject({ ...base, ...entry })),
  });

export const getChartsOutput = z.discriminatedUnion("chart", [
  chartOf("top_sellers", {
    last_week_rank: lastWeekRank,
    consecutive_weeks: z
      .number()
      .nullable()
      .describe("Consecutive weeks on the weekly top-sellers chart, counting this one."),
  }),
  chartOf("most_played", {
    last_week_rank: lastWeekRank,
    peak_in_game: z.number().nullable().describe("Peak concurrent players on the day in `as_of`."),
  }),
  chartOf("most_played_deck", { last_week_rank: lastWeekRank }),
  chartOf("concurrent_players", {
    concurrent_in_game: z.number().nullable().describe("Players in game right now."),
    peak_in_game: z
      .number()
      .nullable()
      .describe("Steam's most recent daily peak of concurrent players."),
  }),
]);
