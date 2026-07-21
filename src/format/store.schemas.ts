// Zod schemas for format/store.ts's summarizers. Each exported summarizer
// builds its return value via `schema.parse({...})` (see store.ts), so the
// schema is the single source of truth for its shape — see storefront.schemas.ts
// for the full rationale. `.strict()` throughout. Also exported for wiring
// into `registerTool`'s `outputSchema` (tools/webStore.ts, tools/webPlayer.ts)
// and for composing the found:true/found:false unions those tools' outputs
// need (get_wishlist, get_recommended_games) alongside format/web.schemas.ts
// and format/shared.schemas.ts.
import { z } from "zod";

// store.ts's compat()/COMPAT_CATEGORY — shared by every
// steam_deck/steam_os/steam_machine/steam_frame field below.
export const compatBadgeSchema = z.enum(["unknown", "unsupported", "playable", "verified"]);

// store.ts's baseCard() — fields common to every store card, independent of
// how price is shaped (get_items, discover_games, get_wishlist's detailed
// cards, get_recommended_games).
export const baseCardSchema = z
  .object({
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
    vr_support: z.enum(["none", "supported", "required"]),
    tags: z.array(z.string()),
    release_date: z.string().nullable(),
  })
  .strict();

// store.ts's storeCard() — baseCard + a FLAT price (discover_games,
// get_wishlist's detailed cards, get_recommended_games).
export const storeCardSchema = baseCardSchema.extend({
  discount_pct: z.number(),
  discount_end: z.string().nullable(),
  original: z.string().nullable(),
  price: z.string().nullable(),
});

export const getItemsOutput = z
  .object({
    count: z.number(),
    items: z.array(
      z.union([
        z.object({ appid: z.number(), available: z.literal(false) }).strict(),
        baseCardSchema.extend({
          is_free: z.boolean(),
          price: z
            .union([
              z
                .object({
                  discount_pct: z.number(),
                  discount_end: z.string().nullable(),
                  final: z.string().nullable(),
                  original: z.string().nullable(),
                })
                .strict(),
              z.object({ is_free: z.literal(true) }).strict(),
            ])
            .nullable(),
          coming_soon: z.boolean(),
        }),
      ]),
    ),
  })
  .strict();

export const discoverGamesOutput = z
  .object({
    total_matching: z
      .number()
      .nullable()
      .describe(
        "Count from whichever filters Steam actually applies server-side — min_discount, and (if " +
          "released_after/released_within_days was set) excluding not-yet-released games — or the " +
          "whole catalog's size if neither was given. NOT the number of games matching tags/" +
          "platform/compat/review/the exact release-date cutoff, which have no server-side filter " +
          "and this tool applies only over the scanned `count`-sized window below. Don't read this " +
          "as 'N games match all my filters' — use `returned` for that instead.",
      ),
    returned: z
      .number()
      .describe("How many results survived every filter, out of the scanned window (see `count`)."),
    deals: z.array(storeCardSchema),
  })
  .strict();

// summarizeWishlistDetailed's found:true shape. The tool-level union with the
// light summarizer's shape (format/web.schemas.ts) and the shared
// wishlistNotFound fragment (format/shared.schemas.ts) is assembled in
// tools/webStore.ts, since that's the layer that knows get_wishlist dispatches
// between the two.
export const wishlistDetailedFound = z
  .object({
    found: z.literal(true),
    total: z
      .number()
      .describe(
        "The player's full wishlist size, including entries Steam never sent store data for (see `enriched`).",
      ),
    enriched: z
      .number()
      .describe(
        "How many of `total` Steam actually attached store data to (it caps around the first " +
          "100) — every filter below only runs over these, never the full `total`.",
      ),
    note: z.string().optional(),
    matched: z
      .number()
      .describe(
        "How many of the enriched items satisfied the filters, BEFORE the display cap — a big " +
          "gap between this and `returned` means results were capped, not that fewer items matched.",
      ),
    returned: z
      .number()
      .describe("How many items are actually in `items` below, after the display cap."),
    items: z.array(
      storeCardSchema.extend({ priority: z.number().nullable(), added: z.string().nullable() }),
    ),
  })
  .strict();

// summarizeRecommendations' found:true shape. get_recommended_games' three
// found:false triggers (web.ts + storeService.ts, see clients/) all share the
// generic notFoundReason fragment (format/shared.schemas.ts); the union is
// assembled in tools/webPlayer.ts.
export const recommendedGamesFound = z
  .object({
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
  })
  .strict();
