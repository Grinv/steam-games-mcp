// Key-required Steam Web API tools: profile, bans, library, achievements,
// friends, vanity resolution. Each short-circuits with a clear "set
// STEAM_API_KEY" message when the key is missing (the target profile must also
// be public). Split out of a single tools/web.ts once it grew past ~550 lines —
// see tools/webStore.ts for the keyless-capable half.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SteamWebClient } from "../clients/web.js";
import { errorResult, type ToolResult } from "../lib/result.js";
import { READ_ONLY, appid, reply } from "./common.js";
import { steamid, steamIdTool } from "./webShared.js";

export function registerPlayerWebTools(server: McpServer, web: SteamWebClient): void {
  // Gate every tool in this file on the key; one clear message instead of a
  // round-trip 403.
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

  server.registerTool(
    "get_game_achievements",
    {
      title: "Get a game's full achievement list",
      description:
        "List ALL achievements of a game by appid with their names, descriptions, hidden flag and " +
        "global unlock % (rarity). Requires STEAM_API_KEY (the achievement schema needs a key). " +
        "For just the rarity by internal id without a key, use get_global_achievements; for a few " +
        "named highlights, see get_game's achievements_highlighted. Get the appid from search_games.",
      inputSchema: {
        appid,
        language: z
          .string()
          .min(2)
          .describe("Language for achievement names/descriptions; overrides STEAM_LANGUAGE.")
          .optional(),
      },
      annotations: READ_ONLY,
    },
    ({ appid: id, language }) => requireKey(() => web.getGameAchievements(id, language)),
  );

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
    "get_friend_list",
    {
      title: "Get a player's friend list",
      description:
        "List a player's Steam friends by SteamID64: name, online state, current game and how " +
        "long they've been friends, most-recently-added first. Requires STEAM_API_KEY and the " +
        "friends list to be public. For 'which of my friends own game X', use find_friends_who_own " +
        "instead — it checks each friend's full library, not just this list. Get the SteamID64 from " +
        "resolve_vanity_url.",
      inputSchema: { steamid },
      annotations: READ_ONLY,
    },
    steamIdTool(web, requireKey, (sid) => web.getFriendList(sid)),
  );

  server.registerTool(
    "find_friends_who_own",
    {
      title: "Find friends who own a game",
      description:
        "Check which of a player's Steam friends own one or more games by appid, with each owner's " +
        "playtime_hours — 'which of my friends have Portal 2 and how long have they played'. Checks " +
        "each friend's FULL library, unlike get_owned_games / get_friend_list which cap at the top " +
        "50 games by playtime — so a friend's rarely-played or unplayed copy is never missed (its " +
        "playtime_hours may still be low or 0). Requires STEAM_API_KEY and the player's friends list " +
        "to be public; friends with a private library are listed separately in private_friends " +
        "(can't be checked) rather than silently counted as non-owners. Get appids from search_games.",
      inputSchema: {
        appids: z
          .array(z.number().int().positive())
          .min(1)
          .max(10)
          .describe("Steam appids to check (1-10)."),
        steamid,
      },
      annotations: READ_ONLY,
    },
    ({ appids, steamid: id }) =>
      requireKey(async () => web.findFriendsWhoOwn(await web.requireSteamId(id), appids)),
  );

  server.registerTool(
    "get_player_summary",
    {
      title: "Get player profile",
      description:
        "Get a player's public profile by SteamID64: display name, online state, country, account " +
        "age, Steam level, and the game they're currently in. Requires STEAM_API_KEY and a public " +
        "profile. For VAC/game/trade ban status instead, use get_player_bans.",
      inputSchema: { steamid },
      annotations: READ_ONLY,
    },
    steamIdTool(web, requireKey, (sid) => web.getPlayerSummary(sid)),
  );

  server.registerTool(
    "get_player_bans",
    {
      title: "Get a player's ban status",
      description:
        "Check a player's VAC, game, community and economy (trade) ban status by SteamID64 — 'is this " +
        "player banned', useful before trading or adding a friend. Ban status is always public — this " +
        "works even when the rest of the profile is private. Requires STEAM_API_KEY.",
      inputSchema: { steamid },
      annotations: READ_ONLY,
    },
    steamIdTool(web, requireKey, (sid) => web.getPlayerBans(sid)),
  );

  server.registerTool(
    "get_owned_games",
    {
      title: "Get owned games",
      description:
        "List the games a player owns with playtime (hours), most-played first (capped to the top " +
        "50 by playtime — a lightly-played or unplayed game may not appear, so this is NOT reliable " +
        "for 'does X own game Y'; use find_friends_who_own for that). Requires STEAM_API_KEY and a " +
        "public profile + game-details visibility. Get the SteamID64 from resolve_vanity_url.",
      inputSchema: { steamid },
      annotations: READ_ONLY,
    },
    steamIdTool(web, requireKey, (sid) => web.getOwnedGames(sid)),
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
    steamIdTool(web, requireKey, (sid) => web.getRecentlyPlayed(sid)),
  );

  server.registerTool(
    "get_player_achievements",
    {
      title: "Get a player's achievements",
      description:
        "Get a player's achievement progress for one game (unlocked count, % complete, per-achievement " +
        "unlock dates) by SteamID64 + appid. Requires STEAM_API_KEY and a public profile.",
      inputSchema: {
        steamid,
        appid,
        language: z
          .string()
          .min(2)
          .describe("Language for achievement names/descriptions; overrides STEAM_LANGUAGE.")
          .optional(),
      },
      annotations: READ_ONLY,
    },
    ({ steamid: id, appid: app, language }) =>
      requireKey(async () =>
        web.getPlayerAchievements(await web.requireSteamId(id), app, language),
      ),
  );
}
