// IsThereAnyDeal tools — catalog-wide deals and price history (the SteamDB-style
// features the Steam APIs don't offer). Both require a free ITAD key; they
// short-circuit with a clear message when ITAD_API_KEY is unset.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ItadClient } from "../clients/itad.js";
import { jsonResult, errorResult, type ToolResult } from "../lib/result.js";
import { guard } from "./guard.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function registerItadTools(server: McpServer, itad: ItadClient): void {
  const requireItad = (fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> => {
    if (!itad.configured) {
      return Promise.resolve(
        errorResult(
          "This tool needs an IsThereAnyDeal API key. Set ITAD_API_KEY to a free key from " +
            "https://isthereanydeal.com/apps/.",
        ),
      );
    }
    return guard(async () => jsonResult(await fn()));
  };

  server.registerTool(
    "get_deals",
    {
      title: "Get current deals (catalog-wide)",
      description:
        "List games currently on sale across the whole catalog (via IsThereAnyDeal), biggest " +
        "discount first, with discount %, sale price, regular price and store link. Use min_cut to " +
        "require a minimum discount (e.g. 80 for '>80% off'). Scoped to Steam by default. This is " +
        "the way to find ALL discounted games — get_specials only covers Steam's front page. Requires ITAD_API_KEY.",
      inputSchema: {
        min_cut: z
          .number()
          .int()
          .min(0)
          .max(100)
          .describe("Minimum discount percent, e.g. 80 means only deals of 80%+ off.")
          .optional(),
        max_price: z
          .number()
          .min(0)
          .describe(
            "Only deals at or below this price. Note: applied client-side over the returned page, " +
              "so combine with limit/offset for wide sweeps.",
          )
          .optional(),
        sort: z
          .enum(["-cut", "cut", "price", "-price", "-time", "time"])
          .describe(
            "Sort order. Default '-cut' (biggest discount first); 'price' = cheapest first.",
          )
          .optional(),
        steam_only: z
          .boolean()
          .describe("Limit to the Steam store (default true). Set false to include all stores.")
          .optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .describe("Max deals to return (default 50).")
          .optional(),
        offset: z.number().int().min(0).describe("Pagination offset.").optional(),
        country: z
          .string()
          .regex(/^[A-Za-z]{2}$/, "Two-letter ISO country code.")
          .describe("Country for prices; overrides STEAM_COUNTRY.")
          .optional(),
      },
      annotations: READ_ONLY,
    },
    (args) => requireItad(() => itad.getDeals(args)),
  );

  server.registerTool(
    "get_game_info",
    {
      title: "Get rich game info (reviews, players, appid)",
      description:
        "Get an IsThereAnyDeal game card in one call: Steam appid, Steam review score (%) and count, " +
        "Metacritic, current players (recent/peak), tags, developers, release date. Pass a Steam " +
        "`appid` or an `itad_id` (e.g. from get_deals). This is how to filter deals by review " +
        "quality — get the itad_id from get_deals, then check steam_review here. Requires ITAD_API_KEY.",
      inputSchema: {
        appid: z
          .number()
          .int()
          .positive()
          .describe("Steam appid (resolved to an ITAD id).")
          .optional(),
        itad_id: z.string().min(1).describe("ITAD game id (UUID), e.g. from get_deals.").optional(),
      },
      annotations: READ_ONLY,
    },
    ({ appid, itad_id }) => {
      if (!appid && !itad_id) {
        return Promise.resolve(errorResult("Provide either appid or itad_id."));
      }
      return requireItad(() => itad.getGameInfo({ appid, itadId: itad_id }));
    },
  );

  server.registerTool(
    "get_current_prices",
    {
      title: "Get current prices for many games (batch)",
      description:
        "Get the current Steam price/discount for a LIST of games by appid in one batch (two ITAD " +
        "calls total, regardless of list size). Each row: cut, price, regular, historic_low, and " +
        "on_sale (false when not currently discounted). Use for 'price-check my wishlist/library'. " +
        "Requires ITAD_API_KEY. (For Steam-native batch pricing without a key, use get_prices.)",
      inputSchema: {
        appids: z
          .array(z.number().int().positive())
          .min(1)
          .max(200)
          .describe("Steam appids to price (1-200)."),
        country: z
          .string()
          .regex(/^[A-Za-z]{2}$/, "Two-letter ISO country code.")
          .describe("Country for prices; overrides STEAM_COUNTRY.")
          .optional(),
      },
      annotations: READ_ONLY,
    },
    ({ appids, country }) => requireItad(() => itad.getCurrentPrices(appids, country)),
  );

  server.registerTool(
    "get_price_history",
    {
      title: "Get price history & all-time low",
      description:
        "Get a game's price history and the lowest price seen (by Steam appid) via IsThereAnyDeal — " +
        "the 'is this discount actually good' check. `lowest` is the minimum within the window; " +
        "widen it with `since` for a true all-time low. Get the appid from search_games. Requires ITAD_API_KEY.",
      inputSchema: {
        appid: z.number().int().positive().describe("Steam application id (appid)."),
        country: z
          .string()
          .regex(/^[A-Za-z]{2}$/, "Two-letter ISO country code.")
          .describe("Country for prices; overrides STEAM_COUNTRY.")
          .optional(),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}/, "ISO date, e.g. 2022-01-01.")
          .describe("Only price changes after this date (ISO). Older date → fuller history.")
          .optional(),
      },
      annotations: READ_ONLY,
    },
    ({ appid, country, since }) => requireItad(() => itad.getPriceHistory(appid, country, since)),
  );
}
