// Steam Storefront tools — game/store data that needs no API key. Descriptions
// and per-field .describe() text are written for the calling model: when to use
// a tool and the meaning of every parameter. Handlers wrap calls in guard() so
// failures become actionable tool errors.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorefrontClient } from "../clients/storefront.js";
import { jsonResult, type ToolResult } from "../lib/result.js";
import { guard } from "./guard.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const appid = z
  .number()
  .int()
  .positive()
  .describe("Steam application id (appid). Get it from search_games.");
// Per-call overrides of the server defaults (STEAM_COUNTRY / STEAM_LANGUAGE).
const country = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "Two-letter ISO country code, e.g. US, RU, DE.")
  .describe("Country (cc) for prices/currency; overrides STEAM_COUNTRY for this call.")
  .optional();
const language = z
  .string()
  .min(2)
  .describe("Store language (e.g. english, russian); overrides STEAM_LANGUAGE for this call.")
  .optional();

const reply = (fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> =>
  guard(async () => jsonResult(await fn()));

export function registerStorefrontTools(server: McpServer, store: StorefrontClient): void {
  server.registerTool(
    "search_games",
    {
      title: "Search games",
      description:
        "Search the Steam store by title; returns matches with their appid (needed by the other " +
        "game tools), price, Metacritic score and platforms. No API key required.",
      inputSchema: {
        term: z.string().min(1).describe("Game title to search for."),
        country,
        language,
      },
      annotations: READ_ONLY,
    },
    ({ term, country: cc, language: l }) => reply(() => store.searchGames(term, cc, l)),
  );

  server.registerTool(
    "get_game",
    {
      title: "Get game details",
      description:
        "Get full store details for one game by appid: description, price/discount, genres, " +
        "platforms, release date, developers/publishers, Metacritic, age rating, DLC and PC " +
        "requirements. Get the appid from search_games. No API key required.",
      inputSchema: { appid, country, language },
      annotations: READ_ONLY,
    },
    ({ appid: id, country: cc, language: l }) => reply(() => store.getGame(id, cc, l)),
  );

  server.registerTool(
    "get_game_reviews",
    {
      title: "Get game reviews",
      description:
        "Get the review summary (score label, positive/negative counts, %) and a few recent " +
        "reviews for a game by appid. Get the appid from search_games. No API key required.",
      inputSchema: {
        appid,
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .describe("How many recent reviews (1-20).")
          .optional(),
        review_language: z
          .string()
          .describe("Filter reviews by language, e.g. 'english'. Default 'all'.")
          .optional(),
        type: z
          .enum(["all", "positive", "negative"])
          .describe("Only positive or negative reviews. Default 'all'.")
          .optional(),
      },
      annotations: READ_ONLY,
    },
    ({ appid: id, limit, review_language, type }) =>
      reply(() => store.getReviews(id, limit ?? 5, review_language ?? "all", type ?? "all")),
  );

  server.registerTool(
    "get_review_histogram",
    {
      title: "Get review trend over time",
      description:
        "Get how a game's reviews trend over time by appid: a long-term (monthly) history and the " +
        "recent per-day breakdown, each with positive/negative counts and positive %. Good for " +
        "'are reviews improving / did an update hurt reception'. Get the appid from search_games. No key.",
      inputSchema: { appid },
      annotations: READ_ONLY,
    },
    ({ appid: id }) => reply(() => store.getReviewHistogram(id)),
  );

  server.registerTool(
    "get_prices",
    {
      title: "Get prices for many games",
      description:
        "Get current price and discount for a batch of games by appid in one call — efficient for " +
        "checking a whole list (e.g. a wishlist) for deals. Each row has the final/initial price and " +
        "discount_percent (or is_free). No API key required. Get appids from search_games or get_wishlist.",
      inputSchema: {
        appids: z
          .array(z.number().int().positive())
          .min(1)
          .max(500)
          .describe("Steam appids to price (1-500)."),
        country,
      },
      annotations: READ_ONLY,
    },
    ({ appids, country: cc }) => reply(() => store.getPrices(appids, cc)),
  );

  server.registerTool(
    "get_specials",
    {
      title: "Get current discounts",
      description:
        "List games currently on special (discounted) on the Steam store front page, with the " +
        "discount % and original/final price. For ALL catalog discounts (not just the front page), " +
        "use get_deals. No API key required.",
      inputSchema: { country, language },
      annotations: READ_ONLY,
    },
    ({ country: cc, language: l }) => reply(() => store.getSpecials(cc, l)),
  );

  server.registerTool(
    "get_featured",
    {
      title: "Get featured store sections",
      description:
        "Get the Steam store's featured sections: specials, top sellers, new releases and coming " +
        "soon (each a list of games with appid and price). No API key required.",
      inputSchema: { country, language },
      annotations: READ_ONLY,
    },
    ({ country: cc, language: l }) => reply(() => store.getFeatured(cc, l)),
  );
}
