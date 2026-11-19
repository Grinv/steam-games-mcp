// Zod schemas for format/storefront.ts's summarizers. Each exported summarizer
// builds its return value via `schema.parse({...})` (see storefront.ts), so the
// schema is the single source of truth for its shape — a missing/extra field
// throws immediately when the summarizer runs, in any test or on real data,
// instead of drifting silently until a separate conformance check catches it.
// `z.strictObject()` throughout so an extra field is exactly that kind of error, not
// silently accepted. Also exported for wiring into `registerTool`'s
// `outputSchema` in tools/storefront.ts.
import { z } from "zod";
import { unchecked, row } from "./shared.ts";
import type { PriceOverview, StoreApp } from "./storefront.ts";

// The currency/final/initial/discount_percent fields formattedPrice() builds,
// shared by detailApp's price() and summarizePrices' rows.
export const priceFieldsSchema = z.strictObject({
  currency: z.string().nullable(),
  final: z.string().nullable(),
  initial: z.string().nullable(),
  discount_percent: z.number(),
});

// detailApp's price() — appdetails-derived price.
export const detailPriceSchema = z
  .discriminatedUnion("is_free", [
    z.strictObject({ is_free: z.literal(true) }),
    priceFieldsSchema.extend({ is_free: z.literal(false) }),
  ])
  .nullable();

export const getGameOutput = z.strictObject({
  appid: z.number().optional(),
  name: z.string().optional(),
  type: z.string().nullable(),
  short_description: z.string().nullable(),
  is_free: z.boolean(),
  price: detailPriceSchema,
  release_date: z.string().nullable(),
  coming_soon: z.boolean(),
  developers: z.array(z.string()),
  publishers: z.array(z.string()),
  genres: z.array(z.string()),
  categories: z.array(z.string()),
  platforms: z.array(z.string()),
  metacritic: z.number().nullable(),
  metacritic_url: z.string().nullable(),
  recommendations: z.number().nullable(),
  required_age: z.union([z.number(), z.string()]).nullable(),
  controller_support: z.string().nullable(),
  achievements_total: z.number().nullable(),
  achievements_highlighted: z
    .array(z.string())
    .describe(
      "A small keyless sample of named achievements Steam highlights for this game, not the full " +
        "list — for every achievement with rarity and a hidden flag, use get_game_achievements instead.",
    ),
  supported_languages: z.string().nullable(),
  dlc: z
    .array(z.number())
    .describe(
      "Appids of this game's DLC, capped — a DLC-heavy game can list hundreds, which would " +
        "dwarf every other field. Compare against dlc_total, and pass the appids to get_items " +
        "for their names and prices.",
    ),
  dlc_total: z.number().describe("How many DLC this game has in total, before the `dlc` cap."),
  demos: z.array(z.number()),
  content_descriptors: z.strictObject({ ids: z.array(z.number()), notes: z.string().nullable() }),
  base_game: z
    .strictObject({ appid: z.number(), name: z.string().nullable() })
    .nullable()
    .describe("The game this DLC, soundtrack or demo belongs to; null for a base game."),
  drm_notice: z.string().nullable(),
  account_notice: z.string().nullable(),
  pc_requirements_min: z.string().nullable(),
  website: z.string().nullable(),
  header_image: z.string().nullable(),
  store_url: z.string().nullable(),
});

// summarizePrices' four literal row shapes (unknown, unavailable, unpriced, priced).
export const getPricesOutput = z.strictObject({
  count: z.number(),
  prices: z.array(
    z.union([
      z
        .strictObject({ appid: z.number(), available: z.literal(false) })
        .describe(
          "Steam has no usable store entry for this appid: it doesn't exist, or it isn't sold in " +
            "the requested country (try another `country`). Same row shape as get_items' " +
            "available:false.",
        ),
      z
        .strictObject({ appid: z.number(), available: z.null() })
        .describe(
          "Unknown: Steam failed to answer for the batch this appid was looked up in (the " +
            "result's `notes` says why). Says nothing about the game — retry for its price.",
        ),
      z
        .strictObject({
          appid: z.number(),
          available: z.literal(true),
          priced: z.literal(false),
        })
        .describe(
          "Steam returned no price block for this appid. That is how a free-to-play title AND a " +
            "not-yet-released or not-purchasable one both come back, and this endpoint cannot " +
            "tell them apart — so this is NOT a claim that the game is free. Call get_items on " +
            "the appid (its `is_free` and `coming_soon` separate the two) before reporting " +
            "anything as free.",
        ),
      priceFieldsSchema.extend({
        appid: z.number(),
        available: z.literal(true),
        is_free: z.literal(false),
      }),
    ]),
  ),
});

// featuredItems()'s per-item shape, shared by summarizeFeatured/summarizeSpecials.
export const featuredItemSchema = z.strictObject({
  appid: z.number().optional(),
  name: z.string().optional(),
  discounted: z.boolean(),
  discount_percent: z.number(),
  original_price: z.string().nullable(),
  final_price: z
    .string()
    .nullable()
    .describe(
      "Current price, or null when this section's payload carries no price — which is every " +
        "`coming_soon` entry (not yet priced, NOT free) and any free-to-play title. Call get_game " +
        "or get_items on the appid when you need to tell those two apart.",
    ),
  store_url: z.string().nullable(),
});

export const getSpecialsOutput = z.strictObject({ specials: z.array(featuredItemSchema) });
export const getFeaturedOutput = z.strictObject({
  specials: z.array(featuredItemSchema),
  top_sellers: z.array(featuredItemSchema),
  new_releases: z.array(featuredItemSchema),
  coming_soon: z.array(featuredItemSchema),
});

// rollup()'s per-entry shape, shared by history/recent.
export const rollupSchema = z.strictObject({
  date: z.string().nullable(),
  up: z.number(),
  down: z.number(),
  positive_pct: z.number().nullable(),
});

export const getReviewHistogramOutput = z.strictObject({
  rollup_type: z
    .string()
    .nullable()
    .describe(
      "Granularity of each `history` entry's date bucket, e.g. 'week' or 'month' — chosen " +
        "server-side by Steam and passed through as a free-form string (not validated or " +
        "enumerated here), so don't assume a fixed set of possible values.",
    ),
  history: z.array(rollupSchema),
  recent: z.array(rollupSchema),
});

// ---- Steam's answers (input) -------------------------------------------------
// Body rules, as in web.schemas.ts: the response types in storefront.ts are
// inferred from these. Only the required fields are checked.

// One appid's appdetails entry: {success:false} — Steam's own "no such app
// here", for a nonexistent, removed or region-locked one — or a success with
// its `data` (seen live 2026-11-20: 620, 570, 1206340, 10110, 219820, 99999999,
// 1174180 under RU). Without `data` a success says nothing, so it isn't one:
// the entry types are inferred from these, and only success:false is a "no".
const isRecord = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
const appEntry = <D>(isData: (v: unknown) => boolean) =>
  z.discriminatedUnion("success", [
    z.looseObject({ success: z.literal(false) }),
    z.looseObject({ success: z.literal(true), data: z.custom<D>(isData) }),
  ]);
// get_game's entry: a success is the app's record.
export const gameEntryInput = appEntry<StoreApp>(isRecord);
// get_prices' rows (filters=price_overview): the price, or [] when the app has
// none (570, free).
export const priceEntryInput = appEntry<{ price_overview: PriceOverview } | []>(
  (v) =>
    (isRecord(v) && isRecord((v as { price_overview?: unknown }).price_overview)) ||
    (Array.isArray(v) && v.length === 0),
);

interface FeaturedItem {
  id?: number;
  // 0 = app. top_sellers also carries bundles (type 2, verified live
  // 2026-10-03: id 72233 is "Destiny 2: The Collection", a /bundle/ page whose
  // /app/ URL redirects to the store front), where `id` is a bundle id.
  type?: number;
  name?: string;
  discounted?: boolean;
  discount_percent?: number;
  // Explicitly nullable: Steam sends `original_price: null` (not an absent key)
  // for anything with no price yet — every coming_soon entry, verified live.
  original_price?: number | null;
  final_price?: number;
  currency?: string;
}
// Each section's object is on every answer; its items are left out when it
// has none (specials under cc=KP or XX, seen live 2026-11-19), so absent is
// empty, not unusable.
const featuredSection = z.looseObject({
  items: z.array(row<FeaturedItem>()).optional(),
});
export const featuredInput = z.looseObject({
  specials: featuredSection,
  top_sellers: featuredSection,
  new_releases: featuredSection,
  coming_soon: featuredSection,
});

interface Rollup {
  date?: number;
  recommendations_up?: number;
  recommendations_down?: number;
}
export const reviewHistogramInput = z.looseObject({
  success: z.literal(1),
  results: z.looseObject({
    rollup_type: unchecked<string>().optional(),
    rollups: z.array(row<Rollup>()).optional(),
    recent: z.array(row<Rollup>()).optional(),
  }),
});
