// Zod schemas for format/storefront.ts's summarizers. Each exported summarizer
// builds its return value via `schema.parse({...})` (see storefront.ts), so the
// schema is the single source of truth for its shape — a missing/extra field
// throws immediately when the summarizer runs, in any test or on real data,
// instead of drifting silently until a separate conformance check catches it.
// `.strict()` throughout so an extra field is exactly that kind of error, not
// silently accepted. Also exported for wiring into `registerTool`'s
// `outputSchema` in tools/storefront.ts.
import { z } from "zod";

// The currency/final/initial/discount_percent fields formattedPrice() builds
// (detailApp's price()) and searchPrice() both produce, independently derived
// from different raw shapes (already-formatted appdetails strings vs. raw
// storesearch cents) but landing on the same final shape — shared here so the
// two summarizers' price fragments can't drift apart from each other either.
export const priceFieldsSchema = z
  .object({
    currency: z.string().nullable(),
    final: z.string().nullable(),
    initial: z.string().nullable(),
    discount_percent: z.number(),
  })
  .strict();

// detailApp's price() — appdetails-derived price.
export const detailPriceSchema = z
  .union([
    z.object({ is_free: z.literal(true) }).strict(),
    priceFieldsSchema.extend({ is_free: z.literal(false) }),
  ])
  .nullable();

// summarizeSearch's searchPrice() — storesearch-derived price (no is_free).
export const searchPriceSchema = priceFieldsSchema.nullable();

export const searchGamesOutput = z
  .object({
    total: z.number(),
    results: z.array(
      z
        .object({
          appid: z.number().optional(),
          name: z.string().optional(),
          type: z.string().nullable(),
          price: searchPriceSchema,
          metascore: z.string().nullable(),
          platforms: z.array(z.string()),
          store_url: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const getGameOutput = z
  .object({
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
    achievements_highlighted: z.array(z.string()),
    supported_languages: z.string().nullable(),
    dlc: z.array(z.number()),
    demos: z.array(z.number()),
    content_descriptors: z
      .object({ ids: z.array(z.number()), notes: z.string().nullable() })
      .strict(),
    base_game: z.object({ appid: z.number(), name: z.string().nullable() }).strict().nullable(),
    drm_notice: z.string().nullable(),
    account_notice: z.string().nullable(),
    pc_requirements_min: z.string().nullable(),
    website: z.string().nullable(),
    header_image: z.string().nullable(),
    store_url: z.string().nullable(),
  })
  .strict();

export const getGameReviewsOutput = z
  .object({
    summary: z.string().nullable(),
    total_reviews: z.number().nullable(),
    total_positive: z.number().nullable(),
    total_negative: z.number().nullable(),
    positive_pct: z.number().nullable(),
    reviews: z.array(
      z
        .object({
          voted_up: z.boolean().nullable(),
          votes_up: z.number(),
          author_playtime_hours: z.number().nullable(),
          text: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

// summarizePrices' three literal row shapes.
export const getPricesOutput = z
  .object({
    count: z.number(),
    prices: z.array(
      z.union([
        z.object({ appid: z.number(), available: z.literal(false) }).strict(),
        z
          .object({ appid: z.number(), available: z.literal(true), is_free: z.literal(true) })
          .strict(),
        priceFieldsSchema.extend({
          appid: z.number(),
          available: z.literal(true),
          is_free: z.literal(false),
        }),
      ]),
    ),
  })
  .strict();

// featuredItems()'s per-item shape, shared by summarizeFeatured/summarizeSpecials.
export const featuredItemSchema = z
  .object({
    appid: z.number().optional(),
    name: z.string().optional(),
    discounted: z.boolean(),
    discount_percent: z.number(),
    original_price: z.string().nullable(),
    final_price: z.string().nullable(),
    store_url: z.string().nullable(),
  })
  .strict();

export const getSpecialsOutput = z.object({ specials: z.array(featuredItemSchema) }).strict();
export const getFeaturedOutput = z
  .object({
    specials: z.array(featuredItemSchema),
    top_sellers: z.array(featuredItemSchema),
    new_releases: z.array(featuredItemSchema),
    coming_soon: z.array(featuredItemSchema),
  })
  .strict();

// rollup()'s per-entry shape, shared by history/recent.
export const rollupSchema = z
  .object({
    date: z.string().nullable(),
    up: z.number(),
    down: z.number(),
    positive_pct: z.number().nullable(),
  })
  .strict();

export const getReviewHistogramOutput = z
  .object({
    rollup_type: z.string().nullable(),
    history: z.array(rollupSchema),
    recent: z.array(rollupSchema),
  })
  .strict();
