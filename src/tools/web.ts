// Steam Web API tools. Player tools (profile, library, achievements, vanity)
// require a free key (STEAM_API_KEY); they short-circuit with a clear message
// when it's missing. News and global achievement % are exposed without that
// gate since Steam currently serves them keyless (a key is still sent if set).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SteamWebClient } from "../clients/web.js";
import { jsonResult, errorResult, type ToolResult } from "../lib/result.js";
import { guard } from "./guard.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const appid = z
  .number()
  .int()
  .positive()
  .describe("Steam application id (appid). Get it from search_games.");
const steamid = z
  .string()
  .regex(
    /^\d{17}$/,
    "A SteamID64 is 17 digits. Use resolve_vanity_url to convert a custom profile name.",
  )
  .describe("17-digit SteamID64. Convert a vanity/custom URL name with resolve_vanity_url first.");

const reply = (fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> =>
  guard(async () => jsonResult(await fn()));

export function registerWebTools(server: McpServer, web: SteamWebClient): void {
  // Gate player tools on the key; one clear message instead of a round-trip 403.
  const requireKey = (fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> => {
    if (!web.configured) {
      return Promise.resolve(
        errorResult(
          "This tool needs a Steam Web API key. Set STEAM_API_KEY to a free key from " +
            "https://steamcommunity.com/dev/apikey. (Note: the target profile must also be public.)",
        ),
      );
    }
    return reply(fn);
  };

  // ---- keyless-capable ------------------------------------------------------

  server.registerTool(
    "get_game_news",
    {
      title: "Get game news",
      description:
        "Get recent news / patch notes for a game by appid (title, date, author, excerpt, link). " +
        "Get the appid from search_games. Works without an API key.",
      inputSchema: {
        appid,
        limit: z.number().int().min(1).max(20).describe("How many news items (1-20).").optional(),
      },
      annotations: READ_ONLY,
    },
    ({ appid: id, limit }) => reply(() => web.getNews(id, limit ?? 5)),
  );

  server.registerTool(
    "get_global_achievements",
    {
      title: "Get global achievement rates",
      description:
        "Get the global unlock percentage of each achievement in a game by appid — how rare each " +
        "achievement is across all players. Get the appid from search_games. Works without a key.",
      inputSchema: { appid },
      annotations: READ_ONLY,
    },
    ({ appid: id }) => reply(() => web.getGlobalAchievements(id)),
  );

  server.registerTool(
    "get_current_players",
    {
      title: "Get current player count",
      description:
        "Get how many people are playing a game right now (live concurrent player count) by appid. " +
        "Get the appid from search_games. Works without a key.",
      inputSchema: { appid },
      annotations: READ_ONLY,
    },
    ({ appid: id }) => reply(() => web.getCurrentPlayers(id)),
  );

  server.registerTool(
    "get_wishlist",
    {
      title: "Get a player's wishlist",
      description:
        "List the appids on a player's Steam wishlist (sorted by their priority) by SteamID64. " +
        "Works without a key, but only if that player's wishlist/profile is public — otherwise it " +
        "returns found:false. Items carry no names; use get_game per appid for details. " +
        "Convert a vanity name with resolve_vanity_url first.",
      inputSchema: { steamid },
      annotations: READ_ONLY,
    },
    ({ steamid: id }) => reply(() => web.getWishlist(id)),
  );

  // ---- player data (key required) -------------------------------------------

  server.registerTool(
    "resolve_vanity_url",
    {
      title: "Resolve vanity URL to SteamID",
      description:
        "Convert a Steam custom (vanity) profile name — the part after /id/ in a profile URL — into " +
        "the 17-digit SteamID64 that the player tools need. Requires STEAM_API_KEY.",
      inputSchema: {
        vanity: z
          .string()
          .min(1)
          .describe(
            "Vanity name, e.g. 'gabelogannewell' from steamcommunity.com/id/gabelogannewell.",
          ),
      },
      annotations: READ_ONLY,
    },
    ({ vanity }) => requireKey(() => web.resolveVanityUrl(vanity)),
  );

  server.registerTool(
    "get_player_summary",
    {
      title: "Get player profile",
      description:
        "Get a player's public profile by SteamID64: display name, online state, country, account " +
        "age, and the game they're currently in. Requires STEAM_API_KEY and a public profile.",
      inputSchema: { steamid },
      annotations: READ_ONLY,
    },
    ({ steamid: id }) => requireKey(() => web.getPlayerSummary(id)),
  );

  server.registerTool(
    "get_owned_games",
    {
      title: "Get owned games",
      description:
        "List the games a player owns with playtime (hours), most-played first. Requires " +
        "STEAM_API_KEY and a public profile + game-details visibility. Get the SteamID64 from resolve_vanity_url.",
      inputSchema: { steamid },
      annotations: READ_ONLY,
    },
    ({ steamid: id }) => requireKey(() => web.getOwnedGames(id)),
  );

  server.registerTool(
    "get_recently_played",
    {
      title: "Get recently played games",
      description:
        "List the games a player has played in the last two weeks, with recent and total playtime. " +
        "Requires STEAM_API_KEY and a public profile.",
      inputSchema: { steamid },
      annotations: READ_ONLY,
    },
    ({ steamid: id }) => requireKey(() => web.getRecentlyPlayed(id)),
  );

  server.registerTool(
    "get_player_achievements",
    {
      title: "Get a player's achievements",
      description:
        "Get a player's achievement progress for one game (unlocked count, % complete, per-achievement " +
        "unlock dates) by SteamID64 + appid. Requires STEAM_API_KEY and a public profile.",
      inputSchema: { steamid, appid },
      annotations: READ_ONLY,
    },
    ({ steamid: id, appid: app }) => requireKey(() => web.getPlayerAchievements(id, app)),
  );
}
