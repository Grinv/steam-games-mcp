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
      },
      annotations: READ_ONLY,
    },
    (args) => requireItad(() => itad.getDeals(args)),
  );

  server.registerTool(
    "get_price_history",
    {
      title: "Get price history & all-time low",
      description:
        "Get a game's price history and the lowest price seen (by Steam appid) via IsThereAnyDeal — " +
        "the 'is this discount actually good' check. Get the appid from search_games. Requires ITAD_API_KEY.",
      inputSchema: {
        appid: z.number().int().positive().describe("Steam application id (appid)."),
      },
      annotations: READ_ONLY,
    },
    ({ appid }) => requireItad(() => itad.getPriceHistory(appid)),
  );
}
