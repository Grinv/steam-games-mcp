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
    total_matching: z.number().nullable(),
    returned: z.number(),
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
    total: z.number(),
    enriched: z.number(),
    note: z.string().optional(),
    matched: z.number(),
    returned: z.number(),
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
      storeCardSchema.extend({ matched_tags: z.array(z.string()), match_score: z.number() }),
    ),
  })
  .strict();
