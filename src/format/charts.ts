// Shapers for Steam's keyless chart services (get_charts):
// IStoreTopSellersService/GetWeeklyTopSellers, ISteamChartsService/
// GetMostPlayedGames and GetGamesByConcurrentPlayers. Lean by design — rank,
// appid, name, link and the chart's own metrics; price/reviews/compat are what
// get_items is for.
import { z } from "zod";
import type { StoreItemsResponse } from "./storeCard.js";
import { isoDateTime, storeUrl } from "./shared.js";
import { getChartsOutput, type chartSchema } from "./charts.schemas.js";

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

interface PlayerRank {
  rank?: number;
  appid?: number;
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

export type ChartName = z.infer<typeof chartSchema>;

// Steam omits last_week_rank for a new entry (verified live on the top-sellers
// chart); 0 is treated the same defensively. Both mean "not charted last week".
const prevRank = (n: number | undefined): number | null => (n ? n : null);

const num = (n: number | undefined): number | null => (typeof n === "number" ? n : null);

/** Appids of the first `limit` ranked entries (what the name lookup needs). */
export function chartAppids(
  r: MostPlayedResponse | ConcurrentPlayersResponse,
  limit: number,
): number[] {
  // Filter before slicing, like the summarizers, so an appid-less entry
  // doesn't cost a slot (and leave the last kept entry nameless).
  return (r.response?.ranks ?? [])
    .map((e) => e.appid)
    .filter((a): a is number => typeof a === "number")
    .slice(0, limit);
}

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
  names: Map<number, string>,
): z.infer<typeof getChartsOutput> {
  const entries = (r.response?.ranks ?? [])
    .filter((e) => typeof e.appid === "number")
    .slice(0, limit)
    .map((e) => ({
      rank: e.rank ?? 0,
      appid: e.appid!,
      name: names.get(e.appid!) ?? null,
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

export function summarizeConcurrentPlayers(
  r: ConcurrentPlayersResponse,
  limit: number,
  names: Map<number, string>,
): z.infer<typeof getChartsOutput> {
  const entries = (r.response?.ranks ?? [])
    .filter((e) => typeof e.appid === "number")
    .slice(0, limit)
    .map((e) => ({
      rank: e.rank ?? 0,
      appid: e.appid!,
      name: names.get(e.appid!) ?? null,
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

/** appid → name from a GetItems response; unnamed items are simply absent. */
export function itemNames(r: StoreItemsResponse): Map<number, string> {
  const map = new Map<number, string>();
  for (const it of r.response?.store_items ?? [])
    if (typeof it.appid === "number" && it.name) map.set(it.appid, it.name);
  return map;
}
