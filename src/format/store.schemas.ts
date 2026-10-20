// Zod schemas for format/store.ts's summarizers. Each exported summarizer
// builds its return value via `schema.parse({...})` (see store.ts), so the
// schema is the single source of truth for its shape — see storefront.schemas.ts
// for the full rationale. `z.strictObject()` throughout. Also exported for wiring
// into `registerTool`'s `outputSchema` (tools/webStore.ts, tools/webPlayer.ts)
// and for composing the found:true/found:false unions those tools' outputs
// need (get_wishlist, get_recommended_games) alongside format/web.schemas.ts
// and format/shared.schemas.ts.
import { z } from "zod";

// store.ts's compat()/COMPAT_CATEGORY — shared by every
// steam_deck/steam_os/steam_machine/steam_frame field below.
export const compatBadgeSchema = z.enum(["unknown", "unsupported", "playable", "verified"]);

// The compat levels a user can FILTER by (discover_games / get_wishlist inputs
// in tools/common.ts, and COMPAT_MIN in store.ts) — the badge set minus the two
// levels there's no point filtering for. Derived from compatBadgeSchema so the
// filter vocabulary and the badge vocabulary stay one source.
export const compatFilterSchema = compatBadgeSchema.exclude(["unknown", "unsupported"]);

// store.ts's vrSupport() — single source of truth for the vr_support labels,
// so the shaper's return type (z.infer) and values (.enum) can't drift from
// what this output field accepts.
export const vrSupportSchema = z.enum(["none", "supported", "required"]);

// store.ts's baseCard() — fields common to every store card, independent of
// how price is shaped (get_items, discover_games, get_wishlist's detailed
// cards, get_recommended_games).
export const baseCardSchema = z.strictObject({
  appid: z.number(),
  name: z.string().nullable(),
  store_url: z.string().nullable(),
  review_percent: z.number().nullable(),
  review_count: z.number().nullable(),
  review_label: z.string().nullable(),
  platforms: z.array(z.string()),
  steam_deck: compatBadgeSchema,
  steam_os: compatBadgeSchema,
  steam_machine: compatBadgeSchema,
  steam_frame: compatBadgeSchema,
  vr_support: vrSupportSchema,
  // One describe here covers every card tool (get_items, discover_games,
  // get_wishlist, get_recommended_games) — the asymmetry below is otherwise
  // reported as a bug by any caller that checks a filtered result.
  tags: z
    .array(z.string())
    .describe(
      "The game's most-weighted user tags, most-relevant first — a display sample capped well " +
        "below the full set, not the complete list. Tag FILTERS (discover_games' and " +
        "get_wishlist's `tags`) match against the game's COMPLETE tag list, so a filtered result " +
        "can legitimately not show the tag you filtered on in this array. Absence here is not " +
        "evidence the game lacks that tag.",
    ),
  release_date: z.string().nullable(),
});

// store.ts's storeCard() — baseCard + a FLAT price (discover_games,
// get_wishlist's detailed cards, get_recommended_games).
export const storeCardSchema = baseCardSchema.extend({
  discount_pct: z.number(),
  discount_end: z.string().nullable(),
  original: z.string().nullable(),
  price: z.string().nullable(),
});

export const getItemsOutput = z.strictObject({
  count: z.number(),
  items: z.array(
    z.union([
      z
        .strictObject({ appid: z.number(), available: z.literal(false) })
        .describe(
          "No store data for this appid: either it doesn't exist, or it isn't sold in the " +
            "requested country. Never dropped from the list, so rows line up with the given appids.",
        ),
      baseCardSchema.extend({
        available: z.literal(true),
        is_free: z.boolean(),
        price: z
          .union([
            z.strictObject({
              discount_pct: z.number(),
              discount_end: z.string().nullable(),
              final: z.string().nullable(),
              original: z.string().nullable(),
            }),
            z.strictObject({ is_free: z.literal(true) }),
          ])
          .nullable()
          .describe(
            "null does NOT mean free: Steam returns no price block when the game isn't sold in " +
              "the requested country, isn't released yet, or has no purchase option. Check is_free " +
              "and coming_soon before concluding anything, and re-check under another `country`.",
          ),
        coming_soon: z.boolean(),
      }),
    ]),
  ),
});

// store.ts's summarizeSearchSuggestions() (search_games). No `currency` code:
// the store services never return one (verified live against every
// data_request flag); the formatted strings already carry the symbol, in
// Steam's own form ("$34.99 USD", "CDN$ 69.99"), like get_items' prices.
export const searchGamesOutput = z.strictObject({
  total: z
    .number()
    .describe("Steam's total number of matches for the term — often more than `returned`."),
  returned: z.number().describe("Results in this response (at most the requested `limit`)."),
  results: z.array(
    z.strictObject({
      appid: z.number(),
      name: z.string().nullable(),
      type: z
        .string()
        .nullable()
        .describe("Store item type: game, dlc, music (soundtrack), demo, software, video, …"),
      price: z
        .strictObject({
          final: z.string().nullable(),
          initial: z.string().nullable(),
          discount_percent: z.number(),
        })
        .nullable()
        .describe("This game's own price; null when free to play or not priced (unreleased)."),
      metascore: z.string().nullable(),
      platforms: z.array(z.string()),
      store_url: z.string().nullable(),
    }),
  ),
});

// store.ts's summarizePurchasePrices() — the base-game purchase price of each
// appid, keyed by appid, used to correct the Storefront API's unreliable
// price_overview (see format/storefront.ts's overridePrice()). Internal to the
// clients, not a tool output: it carries no currency code, because GetItems
// never returns one (verified live against every data_request flag), so the
// Storefront row being corrected keeps supplying that field.
export const purchasePricesSchema = z.record(
  z.string(),
  z.strictObject({
    final: z.string(),
    initial: z.string(),
    discount_percent: z.number(),
  }),
);

export const discoverGamesOutput = z.strictObject({
  total_matching: z
    .number()
    .nullable()
    .describe(
      "Steam's count of catalog games matching the server-side filters (min_discount, release " +
        "date, tags, min_review's rating bucket, one hardware filter). Filters with no " +
        "server-side form (steam_os, platform, min_reviews, a second hardware filter) and the " +
        "exact review-% check are not reflected, so this can overstate; `matched` is exact for " +
        "the fetched page.",
    ),
  matched: z
    .number()
    .describe("How many results in the fetched page (see `count`) survived every filter."),
  returned: z
    .number()
    .describe(
      "How many of `matched` are in `deals` below. Lower than `matched` when the result was " +
        "capped for response size — narrow the filters (or page with `start`) to see the rest.",
    ),
  deals: z.array(storeCardSchema),
});

// summarizeWishlistDetailed's found:true shape. The tool-level union with the
// light summarizer's shape (format/web.schemas.ts) and the shared
// wishlistNotFound fragment (format/shared.schemas.ts) is assembled in
// tools/webStore.ts, since that's the layer that knows get_wishlist dispatches
// between the two.
export const wishlistDetailedFound = z.strictObject({
  found: z.literal(true),
  total: z.number().describe("The player's full wishlist size, before any filter."),
  enriched: z
    .number()
    .describe(
      "How many entries came with store data. Filters Steam applies itself (tags, steam_deck, " +
        "mac/linux, the discount floor) cover the whole wishlist; the review %, own-package " +
        "discount and other compat/platform checks run over these entries only (see `note`).",
    ),
  note: z.string().optional(),
  matched: z
    .number()
    .describe(
      "How many wishlist items satisfied the filters, BEFORE the display cap — a big gap " +
        "between this and `returned` means results were capped, not that fewer items matched.",
    ),
  returned: z
    .number()
    .describe("How many items are actually in `items` below, after the display cap."),
  items: z.array(
    storeCardSchema.extend({ priority: z.number().nullable(), added: z.string().nullable() }),
  ),
});

// summarizeRecommendations' found:true shape. get_recommended_games' three
// found:false triggers (web.ts + storeService.ts, see clients/) all share the
// generic notFoundReason fragment (format/shared.schemas.ts); the union is
// assembled in tools/webPlayer.ts.
export const recommendedGamesFound = z.strictObject({
  found: z.literal(true),
  based_on_tags: z.array(z.string()),
  count: z.number(),
  recommendations: z.array(
    storeCardSchema.extend({
      matched_tags: z.array(z.string()),
      match_score: z
        .number()
        .describe(
          "An internal ranking weight (playtime-on-matched-tags, discounted by review score) — " +
            "not a percentage or 0-100 scale. Only meaningful relative to the other scores in " +
            "this same response, to explain why one pick outranks another.",
        ),
    }),
  ),
});
