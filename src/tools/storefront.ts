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

const reply = (fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> =>
  guard(async () => jsonResult(await fn()));

export function registerStorefrontTools(server: McpServer, store: StorefrontClient): void {
  server.registerTool(
    "search_games",
    {
      title: "Search games",
      description:
        "Search the Steam store by title; returns matches with their appid (needed by the other " +
        "game tools), Metacritic score and platforms. No API key required.",
      inputSchema: { term: z.string().min(1).describe("Game title to search for.") },
      annotations: READ_ONLY,
    },
    ({ term }) => reply(() => store.searchGames(term)),
  );

  server.registerTool(
    "get_game",
    {
      title: "Get game details",
      description:
        "Get full store details for one game by appid: description, price/discount, genres, " +
        "platforms, release date, developers/publishers, Metacritic and PC requirements. " +
        "Get the appid from search_games. No API key required.",
      inputSchema: { appid },
      annotations: READ_ONLY,
    },
    ({ appid: id }) => reply(() => store.getGame(id)),
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
      },
      annotations: READ_ONLY,
    },
    ({ appid: id, limit }) => reply(() => store.getReviews(id, limit ?? 5)),
  );

  server.registerTool(
    "get_specials",
    {
      title: "Get current discounts",
      description:
        "List games currently on special (discounted) on the Steam store, with the discount % and " +
        "original/final price. Good for 'what's on sale right now'. No API key required.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => reply(() => store.getSpecials()),
  );

  server.registerTool(
    "get_featured",
    {
      title: "Get featured store sections",
      description:
        "Get the Steam store's featured sections: specials, top sellers, new releases and coming " +
        "soon (each a list of games with appid and price). No API key required.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => reply(() => store.getFeatured()),
  );
}
