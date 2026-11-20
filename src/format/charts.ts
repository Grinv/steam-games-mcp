// Shapers for Steam's keyless chart services (get_charts):
// IStoreTopSellersService/GetWeeklyTopSellers, ISteamChartsService/
// GetMostPlayedGames, GetMostPlayedSteamDeckGames and GetGamesByConcurrentPlayers. Lean by design — rank,
// appid, name, link and the chart's own metrics; price/reviews/compat are what
// get_items is for.
import { z } from "zod";
import { bodyRule, hasAppid, isoDateTime, storeUrl, usableRows } from "./shared.ts";
import {
  concurrentPlayersInput,
  deckMostPlayedInput,
  getChartsOutput,
  mostPlayedInput,
  topSellersInput,
  type chartSchema,
} from "./charts.schemas.ts";

export type TopSellersResponse = z.infer<typeof topSellersInput>;
export const topSellersRule = bodyRule(topSellersInput, "GetWeeklyTopSellers");
export type MostPlayedResponse = z.infer<typeof mostPlayedInput>;
export const mostPlayedRule = bodyRule(mostPlayedInput, "GetMostPlayedGames");
export type ConcurrentPlayersResponse = z.infer<typeof concurrentPlayersInput>;
export const concurrentPlayersRule = bodyRule(
  concurrentPlayersInput,
  "GetGamesByConcurrentPlayers",
);
export type DeckMostPlayedResponse = z.infer<typeof deckMostPlayedInput>;
export const deckMostPlayedRule = bodyRule(deckMostPlayedInput, "GetMostPlayedSteamDeckGames");

export type ChartName = z.infer<typeof chartSchema>;

// Steam omits last_week_rank for a new entry (verified live on the top-sellers
// chart) and sends -1 on the Deck chart; 0 is treated the same defensively. All
// mean "not charted last week".
const prevRank = (n: number | undefined): number | null => (n && n > 0 ? n : null);

const num = (n: number | undefined): number | null => (typeof n === "number" ? n : null);

export function summarizeTopSellers(
  r: TopSellersResponse,
  limit: number,
): z.infer<typeof getChartsOutput> {
  const entries = usableRows(
    r.response?.ranks,
    hasAppid,
    "chart entries",
    "GetWeeklyTopSellers",
    "appid",
  )
    .slice(0, limit)
    .map((e) => ({
      rank: e.rank ?? 0,
      appid: e.appid,
      name: e.item?.name ?? null,
      store_url: storeUrl(e.appid),
      last_week_rank: prevRank(e.last_week_rank),
      consecutive_weeks: num(e.consecutive_weeks),
    }));
  return getChartsOutput.parse({
    chart: "top_sellers",
    as_of: isoDateTime(r.response?.start_date),
    count: entries.length,
    entries,
  });
}

export function summarizeMostPlayed(
  r: MostPlayedResponse,
  limit: number,
): z.infer<typeof getChartsOutput> {
  const entries = usableRows(
    r.response?.ranks,
    hasAppid,
    "chart entries",
    "GetMostPlayedGames",
    "appid",
  )
    .slice(0, limit)
    .map((e) => ({
      rank: e.rank ?? 0,
      appid: e.appid,
      name: e.item?.name ?? null,
      store_url: storeUrl(e.appid),
      last_week_rank: prevRank(e.last_week_rank),
      peak_in_game: num(e.peak_in_game),
    }));
  return getChartsOutput.parse({
    chart: "most_played",
    as_of: isoDateTime(r.response?.rollup_date),
    count: entries.length,
    entries,
  });
}

export function summarizeMostPlayedDeck(
  r: DeckMostPlayedResponse,
  limit: number,
): z.infer<typeof getChartsOutput> {
  const entries = usableRows(
    r.response?.ranks,
    hasAppid,
    "chart entries",
    "GetMostPlayedSteamDeckGames",
    "appid",
  )
    .slice(0, limit)
    .map((e) => ({
      rank: e.rank ?? 0,
      appid: e.appid,
      name: e.item?.name ?? null,
      store_url: storeUrl(e.appid),
      last_week_rank: prevRank(e.last_period_rank),
    }));
  return getChartsOutput.parse({
    chart: "most_played_deck",
    as_of: null,
    count: entries.length,
    entries,
  });
}

export function summarizeConcurrentPlayers(
  r: ConcurrentPlayersResponse,
  limit: number,
): z.infer<typeof getChartsOutput> {
  const entries = usableRows(
    r.response?.ranks,
    hasAppid,
    "chart entries",
    "GetGamesByConcurrentPlayers",
    "appid",
  )
    .slice(0, limit)
    .map((e) => ({
      rank: e.rank ?? 0,
      appid: e.appid,
      name: e.item?.name ?? null,
      store_url: storeUrl(e.appid),
      concurrent_in_game: num(e.concurrent_in_game),
      peak_in_game: num(e.peak_in_game),
    }));
  return getChartsOutput.parse({
    chart: "concurrent_players",
    as_of: isoDateTime(r.response?.last_update),
    count: entries.length,
    entries,
  });
}
