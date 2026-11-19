// Zod schema for format/charts.ts's summarizeCharts (get_charts). Schema-first,
// like every other format/*.schemas.ts: the shaper builds its return value via
// `getChartsOutput.parse({...})`, so this is the single source of truth for the
// shape and the tool's outputSchema.
import { z } from "zod";
import { unchecked, row } from "./shared.ts";

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

// ---- Steam's answers (input) -------------------------------------------------
// Body rules, as in web.schemas.ts: the response types in charts.ts are
// inferred from these. Only `response` is checked, as an object.

// Names ride along on `item` when the request carries a data_request.
interface Rank {
  rank?: number;
  appid?: number;
  item?: { name?: string };
}
interface TopSellerRank extends Rank {
  last_week_rank?: number;
  consecutive_weeks?: number;
}
interface PlayerRank extends Rank {
  last_week_rank?: number;
  concurrent_in_game?: number;
  peak_in_game?: number;
}
// No date field at all, and a new entry's last_period_rank is -1.
interface DeckRank extends Rank {
  last_period_rank?: number;
}

// A chart's `response` is on every answer. Top sellers leaves its ranks out
// when there is no chart (cc=XX, or a week before Steam's history: seen live
// 2026-11-19, a recorded situation), so there absent is an empty chart. The
// three global player charts always rank 100 games: no ranks there is no
// answer, never an empty chart a cache would keep.
export const topSellersInput = z.looseObject({
  response: z.looseObject({
    start_date: unchecked<number>().optional(),
    ranks: z.array(row<TopSellerRank>()).optional(),
  }),
});
export const mostPlayedInput = z.looseObject({
  response: z.looseObject({
    rollup_date: unchecked<number>().optional(),
    ranks: z.array(row<PlayerRank>()),
  }),
});
export const concurrentPlayersInput = z.looseObject({
  response: z.looseObject({
    last_update: unchecked<number>().optional(),
    ranks: z.array(row<PlayerRank>()),
  }),
});
export const deckMostPlayedInput = z.looseObject({
  response: z.looseObject({ ranks: z.array(row<DeckRank>()) }),
});
