// Shapers for Steam's keyless chart services (get_charts):
// IStoreTopSellersService/GetWeeklyTopSellers, ISteamChartsService/
// GetMostPlayedGames, GetMostPlayedSteamDeckGames and GetGamesByConcurrentPlayers. Lean by design — rank,
// appid, name, link and the chart's own metrics; price/reviews/compat are what
// get_items is for.
import { z } from "zod";
import { isoDateTime, storeUrl } from "./shared.ts";
import { getChartsOutput, type chartSchema } from "./charts.schemas.ts";

export interface TopSellersResponse {
  response?: {
    start_date?: number;
    ranks?: {
      rank?: number;
      appid?: number;
      item?: { name?: string };
      last_week_rank?: number;
      consecutive_weeks?: number;
    }[];
  };
}

// Names ride along on `item` when the request carries a data_request.
interface PlayerRank {
  rank?: number;
  appid?: number;
  item?: { name?: string };
  last_week_rank?: number;
  concurrent_in_game?: number;
  peak_in_game?: number;
}
export interface MostPlayedResponse {
  response?: { rollup_date?: number; ranks?: PlayerRank[] };
}
export interface ConcurrentPlayersResponse {
  response?: { last_update?: number; ranks?: PlayerRank[] };
}

// Names ride along on each rank's `item` (requested via an empty data_request);
// there is no date field at all, and a new entry's last_period_rank is -1.
export interface DeckMostPlayedResponse {
  response?: {
    ranks?: {
      rank?: number;
      appid?: number;
      item?: { name?: string };
      last_period_rank?: number;
    }[];
  };
}

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
  const entries = (r.response?.ranks ?? [])
    .filter((e) => typeof e.appid === "number")
    .slice(0, limit)
    .map((e) => ({
      rank: e.rank ?? 0,
      appid: e.appid!,
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
  const entries = (r.response?.ranks ?? [])
    .filter((e) => typeof e.appid === "number")
    .slice(0, limit)
    .map((e) => ({
      rank: e.rank ?? 0,
      appid: e.appid!,
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
  const entries = (r.response?.ranks ?? [])
    .filter((e) => typeof e.appid === "number")
    .slice(0, limit)
    .map((e) => ({
      rank: e.rank ?? 0,
      appid: e.appid!,
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
  const entries = (r.response?.ranks ?? [])
    .filter((e) => typeof e.appid === "number")
    .slice(0, limit)
    .map((e) => ({
      rank: e.rank ?? 0,
      appid: e.appid!,
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
