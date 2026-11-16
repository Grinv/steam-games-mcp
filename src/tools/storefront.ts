// Steam Storefront tools — game/store data that needs no API key. Descriptions
// and per-field .describe() text are written for the calling model: when to use
// a tool and the meaning of every parameter. Handlers wrap calls in guard() so
// failures become actionable tool errors.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { StorefrontClient } from "../clients/storefront.ts";
import type { StoreServiceClient } from "../clients/storeService.ts";
import { ApiError } from "../lib/errors.ts";
import { toolRegistrar, type ToolOutput } from "./guard.ts";
import { ITEMS_MAX, PRICES_MAX, READ_ONLY, appid, country, language } from "./common.ts";
import {
  getFeaturedOutput,
  getGameOutput,
  getPricesOutput,
  getReviewHistogramOutput,
  getSpecialsOutput,
} from "../format/storefront.schemas.ts";
import { DLC_MAX, HISTOGRAM_HISTORY_MAX, HISTOGRAM_RECENT_MAX } from "../format/storefront.ts";

export function registerStorefrontTools(
  server: McpServer,
  store: StorefrontClient,
  // get_game's name lookup: the same search search_games uses.
  search: StoreServiceClient,
  out: ToolOutput,
): void {
  const tool = toolRegistrar(server, out);
  tool(
    "get_game",
    {
      title: "Get game details",
      description:
        "Get full store details for one game: description, price/discount, genres, platforms, " +
        "release date, developers/publishers, Metacritic, age rating, DLC (the `dlc` appid list is " +
        `capped at ${DLC_MAX} — read \`dlc_total\` for the real count, and pass the appids to ` +
        "get_items for names and prices), PC requirements and a " +
        "small highlighted-achievements sample (achievements_highlighted). " +
        "Identify the game by appid (from search_games) OR by name — a title is resolved to the " +
        "closest store match. Both forms error rather than returning an empty result when nothing " +
        "matches, and an appid can fail for different reasons: it may not exist or have been " +
        "removed from the store, or it may not be sold in the given `country`. The error names the " +
        "country and these causes — retry with another `country` before concluding the game is " +
        "gone. No API key required.",
      inputSchema: z
        .strictObject({
          appid: appid
            .describe("Steam appid (from search_games). Provide appid OR name.")
            .optional(),
          name: z
            .string()
            .trim()
            .nonempty()
            .describe(
              "Game title to look up instead of an appid — resolved to the closest store match. " +
                "Provide appid OR name; appid wins if both are given.",
            )
            .optional(),
          country,
          language,
        })
        .refine((input) => input.appid !== undefined || input.name !== undefined, {
          message: "Provide either appid or name.",
        }),
      outputSchema: getGameOutput,
      annotations: READ_ONLY,
    },
    async ({ appid: id, name, country: cc, language: l }) => {
      let resolved = id;
      if (!resolved) {
        // The schema's .refine() above guarantees name is set whenever appid isn't.
        const found = await search.resolveAppId(name!, cc, l);
        if (!found) {
          throw new ApiError({
            code: "not_found",
            message: `search found no game for name "${name}"`,
            detail: `No Steam game found matching "${name}".`,
          });
        }
        resolved = found;
      }
      return store.getGame(resolved, cc, l);
    },
  );

  tool(
    "get_review_histogram",
    {
      title: "Get review trend over time",
      description:
        "Get how a game's reviews trend over time by appid: a long-term history (rollup_type " +
        "reports each entry's granularity, e.g. 'week' or 'month', chosen server-side by Steam; " +
        `capped at the most recent ${HISTOGRAM_HISTORY_MAX} entries) and the recent per-day breakdown (capped at the most ` +
        `recent ${HISTOGRAM_RECENT_MAX} days), each with positive/negative counts and positive %. Good ` +
        "for 'are reviews improving / did an update hurt reception'. An unknown appid comes back " +
        "as empty `history`/`recent` arrays rather than an error — Steam answers success for any " +
        "id — so an empty result means either no such appid or a game nobody has reviewed yet; " +
        "confirm the appid with get_game if that distinction matters. For a current summary and " +
        "example review text instead of a trend, use get_game_reviews. Get the appid from " +
        "search_games. No API key required.",
      inputSchema: z.strictObject({ appid }),
      outputSchema: getReviewHistogramOutput,
      annotations: READ_ONLY,
    },
    ({ appid: id }) => store.getReviewHistogram(id),
  );

  tool(
    "get_prices",
    {
      title: "Get prices for many games",
      description:
        "Get current price and discount for a batch of games by appid in one call — efficient for " +
        `checking a whole list (e.g. a wishlist) for deals. Handles up to ${PRICES_MAX} appids; if you also ` +
        `need review %, hardware compatibility or tags, use get_items instead (max ${ITEMS_MAX} appids). Rows ` +
        "come back in the same order as the given appids, one per id, never dropped: available:false " +
        "when there's no such appid or it isn't sold in that `country`, available:null when Steam " +
        "failed to answer for it (see `notes`; retry). A " +
        "priced row carries final/initial price and discount_percent. A row marked priced:false " +
        "has no price block at all, which is how BOTH free-to-play and not-yet-released titles " +
        "come back: this endpoint cannot tell them apart, so never report priced:false as 'free' " +
        "— pass those appids to get_items, whose is_free/coming_soon do separate them. " +
        "No API key required. Get appids from search_games or get_wishlist.",
      inputSchema: z.strictObject({
        appids: z
          .array(z.int().positive())
          .nonempty()
          .max(PRICES_MAX)
          .describe(`Steam appids to price (1-${PRICES_MAX}). Split a longer list across calls.`),
        country,
      }),
      outputSchema: getPricesOutput,
      annotations: READ_ONLY,
    },
    ({ appids, country: cc }) => store.getPrices(appids, cc),
  );

  tool(
    "get_specials",
    {
      title: "Get current discounts",
      description:
        "List games currently on special (discounted) on the Steam store front page, with the " +
        "discount % and original/final price. For ALL catalog discounts (not just the front page), " +
        "use discover_games with min_discount. No API key required.",
      inputSchema: z.strictObject({ country, language }),
      outputSchema: getSpecialsOutput,
      annotations: READ_ONLY,
    },
    ({ country: cc, language: l }) => store.getSpecials(cc, l),
  );

  tool(
    "get_featured",
    {
      title: "Get featured store sections",
      description:
        "Get the Steam store's featured sections: specials, top sellers, new releases and coming " +
        "soon (each a list of games with appid and price), all in one call — for a general 'what's " +
        "on the store front page' overview. For just current discounts use get_specials (lighter), " +
        "or discover_games for catalog-wide deals with filters. No API key required.",
      inputSchema: z.strictObject({ country, language }),
      outputSchema: getFeaturedOutput,
      annotations: READ_ONLY,
    },
    ({ country: cc, language: l }) => store.getFeatured(cc, l),
  );
}
