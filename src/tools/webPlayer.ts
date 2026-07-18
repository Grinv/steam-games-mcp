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
        "each friend's FULL library, unlike get_friend_list which caps at the top 50 games by " +
        "playtime — so a friend's rarely-played or unplayed copy is never missed (its playtime_hours " +
        "may still be low or 0). For the PLAYER'S OWN ownership instead of a friend's, use " +
        "get_owned_games's check_appids. Requires STEAM_API_KEY and the player's friends list " +
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
    "compare_players",
    {
      title: "Compare two players' libraries",
      description:
        "Find games two players both own, with each one's playtime — 'what can my friend and I both " +
        "play', 'do we have anything in common'. Checks each player's FULL library, unlike " +
        "get_owned_games which caps at the top 50 by playtime. Requires STEAM_API_KEY and both " +
        "profiles' game-details to be public. Omit steamid to compare against yourself (STEAM_ID).",
      inputSchema: {
        steamid,
        other_steamid: z
          .string()
          .regex(
            /^\d{17}$/,
            "A SteamID64 is 17 digits. Use resolve_vanity_url to convert a custom profile name.",
          )
          .describe("The other player's 17-digit SteamID64 to compare against."),
      },
      annotations: READ_ONLY,
    },
    ({ steamid: id, other_steamid }) =>
      requireKey(async () => web.comparePlayers(await web.requireSteamId(id), other_steamid)),
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
        "List the games a player owns with playtime (hours), most-played first (the `games` list is " +
        "capped to the top 50 by playtime — a lightly-played or unplayed game may not appear there). " +
        "To reliably check whether the player owns one or more SPECIFIC appids regardless of that " +
        "cap — 'do I own game X' — pass check_appids; the `owns` field then checks the FULL, uncapped " +
        "library, with each result's own playtime_hours (null if not owned). For checking a FRIEND's " +
        "ownership instead of the player's own, use find_friends_who_own. Requires STEAM_API_KEY and " +
        "a public profile + game-details visibility. Get the SteamID64 from resolve_vanity_url.",
      inputSchema: {
        steamid,
        check_appids: z
          .array(z.number().int().positive())
          .min(1)
          .max(50)
          .describe(
            "Steam appids to reliably check ownership of (1-50), regardless of the top-50-by-" +
              "playtime cap on `games`. Adds an `owns` field: [{appid, owned, playtime_hours}].",
          )
          .optional(),
      },
      annotations: READ_ONLY,
    },
    ({ steamid: id, check_appids }) =>
      requireKey(async () => web.getOwnedGames(await web.requireSteamId(id), check_appids)),
  );

  server.registerTool(
    "get_recently_played",
    {
      title: "Get recently played games",
      description:
        "List the games a player has played in the last two weeks, with recent and total playtime. " +
        "For all-time top games by playtime instead (capped to the top 50), use get_owned_games. " +
        "Requires STEAM_API_KEY and a public profile.",
      inputSchema: { steamid },
      annotations: READ_ONLY,
    },
    steamIdTool(web, requireKey, (sid) => web.getRecentlyPlayed(sid)),
  );

  server.registerTool(
    "get_recommended_games",
    {
      title: "Get personalized game recommendations",
      description:
        "Recommend unowned Steam catalog games personalized to this player: tags on their own most-" +
        "played owned games become weighted preferences (more playtime on a tag = more weight), " +
        "discounted by each candidate's review score so a tag match on a poorly-received game " +
        "doesn't outrank a better one, then ranked against a broad catalog page, excluding anything " +
        "already owned. `based_on_tags` shows which of the player's own top tags drove the ranking; " +
        "each result carries `matched_tags` and `match_score` alongside the usual price/review/compat " +
        "card. Set exclude_tags to steer away from a genre despite it matching by playtime (e.g. " +
        "'recommend me something except Souls-like'), or min_discount for 'recommend something on a " +
        "good discount' (e.g. 'suggest games on sale, not RPGs or shooters' → " +
        "exclude_tags:['RPG','Shooter','FPS'], min_discount:30). Different from discover_games (which " +
        "needs YOU to name the filters) — this infers taste from the player's WHOLE library instead, " +
        "for 'what should I play next' / 'recommend me something'. For 'something like THIS ONE " +
        "game' (a single named title), get its tags via get_items and call discover_games with them " +
        "instead. Note: candidates are scored from a large but fixed-size catalog scan, so a heavy " +
        "exclude_tags/min_discount combination can return fewer than `count` — there's no larger scan " +
        "to fall back to. Requires STEAM_API_KEY and a public profile with game-details visible " +
        "(same requirement as get_owned_games).",
      inputSchema: {
        steamid,
        count: z
          .number()
          .int()
          .min(1)
          .max(25)
          .describe("How many recommendations to return (default 10).")
          .optional(),
        exclude_tags: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Drop any candidate carrying ANY of these tags (case-insensitive), e.g. " +
              "['Souls-like'] for 'recommend me something except Souls-like'.",
          )
          .optional(),
        min_discount: z
          .number()
          .int()
          .min(1)
          .max(100)
          .describe(
            "Minimum discount %, e.g. 30 for '30%+ off'. Omit to include full-price games too.",
          )
          .optional(),
      },
      annotations: READ_ONLY,
    },
    ({ steamid: id, count, exclude_tags, min_discount }) =>
      requireKey(async () =>
        web.getRecommendedGames(await web.requireSteamId(id), {
          count,
          excludeTags: exclude_tags,
          minDiscount: min_discount,
        }),
      ),
  );

  server.registerTool(
    "get_player_achievements",
    {
      title: "Get a player's achievements",
      description:
        "Get a player's achievement progress for one game (unlocked count, % complete, per-achievement " +
        "unlock dates) by SteamID64 + appid. For the game's full achievement list (names, " +
        "descriptions, global rarity) independent of any player, use get_game_achievements instead; " +
        "for just the rarity without a key, use get_global_achievements. Requires STEAM_API_KEY and " +
        "a public profile.",
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
