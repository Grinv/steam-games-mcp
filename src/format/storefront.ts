// Trims verbose Steam Storefront payloads (store.steampowered.com/api/*) down to
// the fields an agent needs. Clients fetch + cache; all raw→agent-facing shaping
// lives here. Companion to ./web.ts (official Web API) and ./shared.ts (helpers).
//
// Every exported summarizer below builds its return value via a matching
// `z.strictObject()` zod schema's `.parse({...})` (see storefront.schemas.ts) instead
// of a bare object literal — the schema is the single source of truth for the
// shape, so a missing/extra field throws immediately when the summarizer runs
// (any test, or a real call) instead of silently drifting from the
// `outputSchema` advertised to MCP clients.

import { z } from "zod";
import type { PurchasePrices } from "./store.ts";
import { appidValue } from "../steam.ts";
import { bodyRule, capList, isoDay, money, names, storeUrl, stripHtml } from "./shared.ts";
import {
  appEntryInput,
  detailPriceSchema,
  featuredInput,
  featuredItemSchema,
  getFeaturedOutput,
  getGameOutput,
  getPricesOutput,
  getReviewHistogramOutput,
  getSpecialsOutput,
  priceFieldsSchema,
  reviewHistogramInput,
  rollupSchema,
} from "./storefront.schemas.ts";

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

/** One appid's corrected price, as produced by format/store.ts's
 *  summarizePurchasePrices(). */
type PriceOverride = PurchasePrices[string];

/** Steam's Storefront API fills BOTH appdetails' `price_overview` and
 *  storesearch's `price` from the FIRST sub of an app's default package group
 *  rather than from its base game, so any app whose first sub is an upgrade SKU
 *  gets reported at the upgrade's price with discount_percent 0. Verified live
 *  on appid 3717330 (Yakuza Kiwami, cc=ID): price_overview says Rp 20 000 and
 *  no discount — that's package 1466003, the upgrade for owners of Kiwami
 *  (Legacy) — while the store page, Steam's own search page and GetItems' base
 *  package 1308688 all say Rp 200 000 -> Rp 120 000 (-40%). Nor is it simply
 *  "the cheapest sub": appid 3937550 has a Rp 259 000 Deluxe Upgrade sub yet
 *  correctly reports its Rp 579 000 base, which happens to sit first there.
 *  Nothing in the payload flags the case — both subs carry percent_savings 0 and
 *  the real discount survives only as HTML inside option_text — so the amounts
 *  come from the app's own package in IStoreBrowseService/GetItems' purchase
 *  options, the same one every store card prices (clients/storeService.ts's
 *  getPurchasePrices).
 *
 *  Only the three amount fields are replaced; `currency` stays from the
 *  Storefront row, since GetItems returns no currency code at all. And only a
 *  row that already HAS a price is corrected — where Steam reports no price
 *  (free, unreleased, not sold in this country) that answer stands, rather than
 *  inventing one from a package the store isn't currently offering. */
function overridePrice(
  fields: z.infer<typeof priceFieldsSchema>,
  override: PriceOverride | undefined,
): z.infer<typeof priceFieldsSchema> {
  return override ? { ...fields, ...override } : fields;
}

// The formatted price fields shared by detailApp's price() and summarizePrices.
// Not `.parse()`d here — the exported summarizer that embeds this already
// validates the whole object once; parsing again here would just re-check the
// same fields a second time for no benefit. The `z.infer` return type still
// gets this checked at the TS level.
function formattedPrice(
  p: PriceOverview,
  override?: PriceOverride,
): z.infer<typeof priceFieldsSchema> {
  return overridePrice(
    {
      currency: p.currency ?? null,
      final: p.final_formatted ?? null,
      // Steam leaves initial_formatted empty when there's no discount.
      initial: p.initial_formatted || p.final_formatted || null,
      discount_percent: p.discount_percent ?? 0,
    },
    override,
  );
}

function price(
  p: PriceOverview | undefined,
  isFree: boolean | undefined,
  override?: PriceOverride,
): z.infer<typeof detailPriceSchema> {
  // A wrong `is_free` is the same trap one field over: appdetails flags
  // theHunter: Call of the Wild (appid 518790) as free because its default
  // group opens with the free upgrade for theHunter Classic owners, though the
  // game costs $19.99. An override only exists for an app GetItems prices as a
  // paid package of its own, so it outranks the flag — and, for the same
  // reason, can stand in for a missing price_overview.
  if (isFree && !override) return { is_free: true };
  if (!p && !override) return null;
  return { is_free: false, ...formattedPrice(p ?? {}, override) };
}

function platforms(p: StoreApp["platforms"]): string[] {
  if (!p) return [];
  return Object.entries(p)
    .filter(([, on]) => on)
    .map(([os]) => os);
}

// `dlc` is a bare appid list with no names, so it's near-useless past a sample
// yet can dominate the whole response: Train Simulator Classic (appid 24010)
// ships 791 DLC appids, ~5.8 KB of digits and two thirds of the payload. Capped
// like every other collection in this codebase, with dlc_total for the real
// count. Sized to still cover the ordinary "a few dozen DLC" game whole.
export const DLC_MAX = 50;

export function detailApp(a: StoreApp, override?: PriceOverride): z.infer<typeof getGameOutput> {
  const reqs = Array.isArray(a.pc_requirements) ? undefined : a.pc_requirements;
  const allDlc = a.dlc ?? [];
  const dlc = capList(allDlc, DLC_MAX);
  return getGameOutput.parse({
    appid: a.steam_appid,
    name: a.name,
    type: a.type ?? null,
    short_description: stripHtml(a.short_description),
    // Deliberately not `a.is_free` alone: see price()'s note on appdetails
    // flagging a paid game free. These two must never disagree.
    is_free: override ? false : (a.is_free ?? false),
    price: price(a.price_overview, a.is_free, override),
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
    dlc: dlc.included,
    dlc_total: allDlc.length,
    demos: (a.demos ?? []).map((d) => d.appid).filter((id): id is number => typeof id === "number"),
    // Content descriptor ids flag mature themes (violence/nudity/etc.); notes
    // is Valve's free-text. Empty ids → no mature descriptors.
    content_descriptors: {
      ids: a.content_descriptors?.ids ?? [],
      notes: a.content_descriptors?.notes ?? null,
    },
    // Steam's `fullgame`: the game a DLC, soundtrack or demo belongs to, its
    // appid a numeric string (seen live 2026-11-19 on 2778580, 1206340, 219).
    // An id that isn't an appid ("0", "-1", NaN) names no base game.
    base_game: appidValue.safeParse(Number(a.fullgame?.appid)).success
      ? { appid: Number(a.fullgame!.appid), name: a.fullgame!.name ?? null }
      : null,
    drm_notice: a.drm_notice || null,
    account_notice: a.ext_user_account_notice || null,
    pc_requirements_min: stripHtml(reqs?.minimum),
    website: a.website || null,
    header_image: a.header_image || null,
    store_url: storeUrl(a.steam_appid),
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
// order.
//
// A success:true entry with no price_overview reports priced:false, NOT
// is_free:true. Confirmed live against appdetails?filters=price_overview: both
// a genuinely free game (570, Dota 2) and an unreleased paid one (a
// coming_soon title) answer with the identical `"data": []`, so freeness is not
// something this endpoint's response can establish — claiming it made
// get_prices answer "free" for unreleased paid titles, contradicting get_items
// on the same appid in the same second. This is the same trap 0.13.0 fixed for
// get_featured's "0.00 USD"; featuredItemSchema's final_price documents it too.
// get_items reads IStoreBrowseService, which carries a real is_free flag.

/** An appdetails entry Steam answered: an object with a boolean `success`
 *  (appEntryInput). It answers every appid it's asked about, a nonexistent,
 *  removed or region-locked one included ({success:false}; all seen live
 *  2026-11-19). Per row for a batch; get_game's one entry is a body rule. */
export const usableAppEntry = (e: unknown): boolean => appEntryInput.safeParse(e).success;
export const appEntryRule = bodyRule(appEntryInput, "appdetails' entry for the appid");

export function summarizePrices(
  merged: PriceDetailsResponse,
  appids: number[],
  overrides: PurchasePrices = {},
): z.infer<typeof getPricesOutput> {
  const prices = appids.map((id) => {
    const entry = merged[String(id)];
    // No entry (its chunk failed, or the client dropped one without
    // `success`): unknown, never "not available"; either is noted.
    if (!entry) return { appid: id, available: null };
    const data = entry.data;
    const po = data && !Array.isArray(data) ? data.price_overview : undefined;
    if (!entry.success) return { appid: id, available: false as const };
    if (!po) return { appid: id, available: true as const, priced: false as const };
    return {
      appid: id,
      available: true as const,
      is_free: false as const,
      ...formattedPrice(po, overrides[String(id)]),
    };
  });
  return getPricesOutput.parse({ count: prices.length, prices });
}

// ---- Storefront: featuredcategories -----------------------------------------

export type FeaturedResponse = z.infer<typeof featuredInput>;
export const featuredRule = bodyRule(featuredInput, "featuredcategories");
type FeaturedItem = NonNullable<FeaturedResponse["specials"]["items"]>[number];

// Not `.parse()`d per item — see formattedPrice()'s comment; the enclosing
// summarizeFeatured()/summarizeSpecials() validates the whole result once.
//
// Steam's featuredcategories endpoint itself repeats the same appid within a
// section (confirmed live against store.steampowered.com/api/featuredcategories),
// so dedupe here rather than passing upstream's repeats through to the agent.
function featuredItems(items: FeaturedItem[] | undefined): z.infer<typeof featuredItemSchema>[] {
  const seen = new Set<number>();
  const out: z.infer<typeof featuredItemSchema>[] = [];
  for (const i of items ?? []) {
    // Keep apps only: a bundle's id rendered as `appid` sends the agent to a
    // broken store_url and makes get_game/get_items fail on it.
    if (i.type !== undefined && i.type !== 0) continue;
    if (i.id !== undefined) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
    }
    out.push({
      appid: i.id,
      name: i.name,
      discounted: i.discounted ?? false,
      discount_percent: i.discount_percent ?? 0,
      original_price: money(i.original_price, i.currency),
      // A not-yet-priced game (every `coming_soon` entry, confirmed against
      // appdetails: is_free:false with price_overview:null) arrives as
      // final_price 0 with original_price null — which money() rendered as
      // "0.00 USD", so an agent reported an unreleased paid game as free. Null
      // means "no price yet"; a genuinely free title is indistinguishable in
      // this payload, so "unknown" is the honest answer for both. `== null`
      // deliberately: Steam sends an explicit null here, not an absent key.
      final_price:
        i.final_price === 0 && i.original_price == null ? null : money(i.final_price, i.currency),
      store_url: storeUrl(i.id),
    });
  }
  return out;
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

export type ReviewHistogramResponse = z.infer<typeof reviewHistogramInput>;
export const reviewHistogramRule = bodyRule(reviewHistogramInput, "appreviewhistogram");
type Rollup = NonNullable<ReviewHistogramResponse["results"]["rollups"]>[number];

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
// last ~30 days. Cap both so the response stays bounded — most recent kept,
// since a trend question is about the near end. Exported like every other cap
// in this codebase so get_review_histogram's description can't state a number
// the shaper has since moved away from; these two were the last bare literals.
export const HISTOGRAM_HISTORY_MAX = 24;
export const HISTOGRAM_RECENT_MAX = 30;

export function summarizeReviewHistogram(
  r: ReviewHistogramResponse,
): z.infer<typeof getReviewHistogramOutput> {
  const res = r.results ?? {};
  return getReviewHistogramOutput.parse({
    rollup_type: res.rollup_type ?? null,
    history: (res.rollups ?? []).slice(-HISTOGRAM_HISTORY_MAX).map(rollup),
    recent: (res.recent ?? []).slice(-HISTOGRAM_RECENT_MAX).map(rollup),
  });
}
