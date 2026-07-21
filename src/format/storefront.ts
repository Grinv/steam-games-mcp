// Trims verbose Steam Storefront payloads (store.steampowered.com/api/*) down to
// the fields an agent needs. Clients fetch + cache; all raw→agent-facing shaping
// lives here. Companion to ./web.ts (official Web API) and ./shared.ts (helpers).
//
// Every exported summarizer below builds its return value via a matching
// `.strict()` zod schema's `.parse({...})` (see storefront.schemas.ts) instead
// of a bare object literal — the schema is the single source of truth for the
// shape, so a missing/extra field throws immediately when the summarizer runs
// (any test, or a real call) instead of silently drifting from the
// `outputSchema` advertised to MCP clients.

import { z } from "zod";
import { hours, isoDay, money, names, storeUrl, stripHtml } from "./shared.js";
import {
  detailPriceSchema,
  featuredItemSchema,
  getFeaturedOutput,
  getGameOutput,
  getGameReviewsOutput,
  getPricesOutput,
  getReviewHistogramOutput,
  getSpecialsOutput,
  priceFieldsSchema,
  rollupSchema,
  searchGamesOutput,
  searchPriceSchema,
} from "./storefront.schemas.js";

// ---- Storefront: appdetails -------------------------------------------------

interface PriceOverview {
  currency?: string;
  initial?: number;
  final?: number;
  discount_percent?: number;
  initial_formatted?: string;
  final_formatted?: string;
}
export interface StoreApp {
  type?: string;
  name?: string;
  steam_appid?: number;
  is_free?: boolean;
  short_description?: string;
  detailed_description?: string;
  about_the_game?: string;
  supported_languages?: string;
  header_image?: string;
  website?: string | null;
  developers?: string[];
  publishers?: string[];
  price_overview?: PriceOverview;
  platforms?: { windows?: boolean; mac?: boolean; linux?: boolean };
  metacritic?: { score?: number; url?: string };
  categories?: { id?: number; description?: string }[];
  genres?: { id?: string; description?: string }[];
  release_date?: { coming_soon?: boolean; date?: string };
  recommendations?: { total?: number };
  pc_requirements?: { minimum?: string; recommended?: string } | [];
  required_age?: number | string;
  dlc?: number[];
  achievements?: { total?: number; highlighted?: { name?: string; path?: string }[] };
  controller_support?: string;
  content_descriptors?: { ids?: number[]; notes?: string | null };
  fullgame?: { appid?: string; name?: string };
  demos?: { appid?: number; description?: string }[];
  drm_notice?: string;
  ext_user_account_notice?: string;
}

// The formatted price fields shared by detailApp's price() and summarizePrices.
// Not `.parse()`d here — the exported summarizer that embeds this already
// validates the whole object once; parsing again here would just re-check the
// same fields a second time for no benefit. The `z.infer` return type still
// gets this checked at the TS level.
function formattedPrice(p: PriceOverview): z.infer<typeof priceFieldsSchema> {
  return {
    currency: p.currency ?? null,
    final: p.final_formatted ?? null,
    // Steam leaves initial_formatted empty when there's no discount.
    initial: p.initial_formatted || p.final_formatted || null,
    discount_percent: p.discount_percent ?? 0,
  };
}

function price(
  p: PriceOverview | undefined,
  isFree: boolean | undefined,
): z.infer<typeof detailPriceSchema> {
  if (isFree) return { is_free: true };
  if (!p) return null;
  return { is_free: false, ...formattedPrice(p) };
}

function platforms(p: StoreApp["platforms"]): string[] {
  if (!p) return [];
  return Object.entries(p)
    .filter(([, on]) => on)
    .map(([os]) => os);
}

export function detailApp(a: StoreApp): z.infer<typeof getGameOutput> {
  const reqs = Array.isArray(a.pc_requirements) ? undefined : a.pc_requirements;
  return getGameOutput.parse({
    appid: a.steam_appid,
    name: a.name,
    type: a.type ?? null,
    short_description: a.short_description || null,
    is_free: a.is_free ?? false,
    price: price(a.price_overview, a.is_free),
    release_date: a.release_date?.date || null,
    coming_soon: a.release_date?.coming_soon ?? false,
    developers: a.developers ?? [],
    publishers: a.publishers ?? [],
    genres: names(a.genres),
    categories: names(a.categories),
    platforms: platforms(a.platforms),
    metacritic: a.metacritic?.score ?? null,
    metacritic_url: a.metacritic?.url ?? null,
    recommendations: a.recommendations?.total ?? null,
    required_age: a.required_age ?? null,
    controller_support: a.controller_support ?? null,
    achievements_total: a.achievements?.total ?? null,
    // A keyless sample of named achievements; use get_game_achievements for all.
    achievements_highlighted: (a.achievements?.highlighted ?? [])
      .map((h) => h.name)
      .filter((n): n is string => Boolean(n)),
    supported_languages: stripHtml(a.supported_languages),
    dlc: a.dlc ?? [],
    demos: (a.demos ?? []).map((d) => d.appid).filter((id): id is number => typeof id === "number"),
    // Content descriptor ids flag mature themes (violence/nudity/etc.); notes
    // is Valve's free-text. Empty ids → no mature descriptors.
    content_descriptors: {
      ids: a.content_descriptors?.ids ?? [],
      notes: a.content_descriptors?.notes ?? null,
    },
    // Present only for DLC: the base game it belongs to.
    base_game: a.fullgame?.appid
      ? { appid: Number(a.fullgame.appid), name: a.fullgame.name ?? null }
      : null,
    drm_notice: a.drm_notice || null,
    account_notice: a.ext_user_account_notice || null,
    pc_requirements_min: stripHtml(reqs?.minimum),
    website: a.website || null,
    header_image: a.header_image || null,
    store_url: storeUrl(a.steam_appid),
  });
}

// ---- Storefront: storesearch ------------------------------------------------

interface SearchItem {
  type?: string;
  name?: string;
  id?: number;
  price?: { currency?: string; initial?: number; final?: number };
  tiny_image?: string;
  metascore?: string;
  platforms?: { windows?: boolean; mac?: boolean; linux?: boolean };
}
export interface SearchResponse {
  total?: number;
  items?: SearchItem[];
}

// storesearch prices are raw cents (initial/final); derive a discount + labels.
// Not `.parse()`d — see formattedPrice()'s comment; summarizeSearch validates
// the whole result once.
function searchPrice(p: SearchItem["price"]): z.infer<typeof searchPriceSchema> {
  if (!p || typeof p.final !== "number") return null;
  const discount =
    p.initial && p.final && p.initial > p.final ? Math.round((1 - p.final / p.initial) * 100) : 0;
  return {
    currency: p.currency ?? null,
    final: money(p.final, p.currency),
    initial: money(p.initial, p.currency),
    discount_percent: discount,
  };
}

export function summarizeSearch(r: SearchResponse): z.infer<typeof searchGamesOutput> {
  return searchGamesOutput.parse({
    total: r.total ?? r.items?.length ?? 0,
    results: (r.items ?? []).map((i) => ({
      appid: i.id,
      name: i.name,
      type: i.type ?? null,
      price: searchPrice(i.price),
      metascore: i.metascore || null,
      platforms: platforms(i.platforms),
      store_url: storeUrl(i.id),
    })),
  });
}

// ---- Storefront: batch prices (appdetails?filters=price_overview) -----------

// appdetails keyed by appid; with the price_overview filter, `data` is either
// { price_overview } or an empty array (free / no price).
export type PriceDetailsResponse = Record<
  string,
  { success?: boolean; data?: { price_overview?: PriceOverview } | [] }
>;

// Shape a merged batch response into one row per requested appid, preserving
// order. Missing/free entries come back with is_free:true and no numbers.
export function summarizePrices(
  merged: PriceDetailsResponse,
  appids: number[],
): z.infer<typeof getPricesOutput> {
  const prices = appids.map((id) => {
    const entry = merged[String(id)];
    const data = entry?.data;
    const po = data && !Array.isArray(data) ? data.price_overview : undefined;
    if (!entry?.success) return { appid: id, available: false as const };
    if (!po) return { appid: id, available: true as const, is_free: true as const };
    return { appid: id, available: true as const, is_free: false as const, ...formattedPrice(po) };
  });
  return getPricesOutput.parse({ count: prices.length, prices });
}

// ---- Storefront: appreviews -------------------------------------------------

export interface ReviewsResponse {
  success?: number;
  query_summary?: {
    num_reviews?: number;
    review_score?: number;
    review_score_desc?: string;
    total_positive?: number;
    total_negative?: number;
    total_reviews?: number;
  };
  reviews?: {
    review?: string;
    voted_up?: boolean;
    votes_up?: number;
    timestamp_created?: number;
    author?: { playtime_forever?: number };
  }[];
}

export function summarizeReviews(
  r: ReviewsResponse,
  max = 5,
): z.infer<typeof getGameReviewsOutput> {
  const q = r.query_summary ?? {};
  return getGameReviewsOutput.parse({
    summary: q.review_score_desc ?? null,
    total_reviews: q.total_reviews ?? null,
    total_positive: q.total_positive ?? null,
    total_negative: q.total_negative ?? null,
    positive_pct:
      q.total_reviews && q.total_positive
        ? Math.round((q.total_positive / q.total_reviews) * 100)
        : null,
    reviews: (r.reviews ?? []).slice(0, max).map((x) => ({
      voted_up: x.voted_up ?? null,
      votes_up: x.votes_up ?? 0,
      author_playtime_hours: hours(x.author?.playtime_forever),
      text: x.review ? (x.review.length > 600 ? x.review.slice(0, 600) + "…" : x.review) : null,
    })),
  });
}

// ---- Storefront: featuredcategories -----------------------------------------

interface FeaturedItem {
  id?: number;
  name?: string;
  discounted?: boolean;
  discount_percent?: number;
  original_price?: number;
  final_price?: number;
  currency?: string;
}
export interface FeaturedResponse {
  specials?: { items?: FeaturedItem[] };
  top_sellers?: { items?: FeaturedItem[] };
  new_releases?: { items?: FeaturedItem[] };
  coming_soon?: { items?: FeaturedItem[] };
}

// Not `.parse()`d per item — see formattedPrice()'s comment; the enclosing
// summarizeFeatured()/summarizeSpecials() validates the whole result once.
function featuredItems(items: FeaturedItem[] | undefined): z.infer<typeof featuredItemSchema>[] {
  return (items ?? []).map((i) => ({
    appid: i.id,
    name: i.name,
    discounted: i.discounted ?? false,
    discount_percent: i.discount_percent ?? 0,
    original_price: money(i.original_price, i.currency),
    final_price: money(i.final_price, i.currency),
    store_url: storeUrl(i.id),
  }));
}

export function summarizeFeatured(r: FeaturedResponse): z.infer<typeof getFeaturedOutput> {
  return getFeaturedOutput.parse({
    specials: featuredItems(r.specials?.items),
    top_sellers: featuredItems(r.top_sellers?.items),
    new_releases: featuredItems(r.new_releases?.items),
    coming_soon: featuredItems(r.coming_soon?.items),
  });
}

export function summarizeSpecials(r: FeaturedResponse): z.infer<typeof getSpecialsOutput> {
  return getSpecialsOutput.parse({ specials: featuredItems(r.specials?.items) });
}

// ---- Storefront: review histogram -------------------------------------------

interface Rollup {
  date?: number;
  recommendations_up?: number;
  recommendations_down?: number;
}
export interface ReviewHistogramResponse {
  success?: number;
  results?: { rollup_type?: string; rollups?: Rollup[]; recent?: Rollup[] };
}

// Not `.parse()`d per entry — see formattedPrice()'s comment;
// summarizeReviewHistogram validates the whole result once.
function rollup(x: Rollup): z.infer<typeof rollupSchema> {
  const up = x.recommendations_up ?? 0;
  const down = x.recommendations_down ?? 0;
  const total = up + down;
  return {
    date: isoDay(x.date),
    up,
    down,
    positive_pct: total ? Math.round((up / total) * 100) : null,
  };
}

// `rollups` is the long-term trend (monthly here); `recent` is per-day for the
// last ~30 days. Cap both so the response stays bounded.
export function summarizeReviewHistogram(
  r: ReviewHistogramResponse,
): z.infer<typeof getReviewHistogramOutput> {
  const res = r.results ?? {};
  return getReviewHistogramOutput.parse({
    rollup_type: res.rollup_type ?? null,
    history: (res.rollups ?? []).slice(-24).map(rollup),
    recent: (res.recent ?? []).slice(-30).map(rollup),
  });
}
