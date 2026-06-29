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
  .describe(
    "17-digit SteamID64. Omit to use the STEAM_ID configured on the server. " +
      "Convert a vanity/custom URL name with resolve_vanity_url first.",
  )
  .optional();

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
    "get_items",
    {
      title: "Batch store card for many games",
      description:
        "Get price/discount, review % (positive), Steam Deck compatibility and release date for a " +
        "LIST of games by appid in ONE keyless call. The efficient way to price-, rating- and " +
        "Deck-check a wishlist or library without a request per game (each item carries a steam_deck " +
        "field: verified/playable/unsupported/unknown). Get appids from search_games / get_wishlist / get_owned_games.",
      inputSchema: {
        appids: z
          .array(z.number().int().positive())
          .min(1)
          .max(100)
          .describe("Steam appids (1-100)."),
        country: z
          .string()
          .regex(/^[A-Za-z]{2}$/, "Two-letter ISO country code.")
          .describe("Country (cc) for prices; overrides STEAM_COUNTRY.")
          .optional(),
        language: z
          .string()
          .min(2)
          .describe("Store language; overrides STEAM_LANGUAGE.")
          .optional(),
      },
      annotations: READ_ONLY,
    },
    ({ appids, country, language }) => reply(() => web.getItems(appids, country, language)),
  );

  server.registerTool(
    "discover_games",
    {
      title: "Discover games (deals, new releases, Steam Deck, rating)",
      description:
        "Find games across the whole Steam catalog (keyless), filtered by ANY combination of: " +
        "discount (min_discount — for 'what's on sale'), release recency (released_after / " +
        "released_within_days — for 'new games'), Steam Deck compatibility (steam_deck), and review " +
        "quality (min_review / min_reviews). Each result returns price/discount, review %, Steam Deck " +
        "status and release date in one call. Examples: '>80% off with 90%+ reviews' → set min_discount " +
        "+ min_review; 'recent well-reviewed games that run on Steam Deck' → set released_within_days + " +
        "steam_deck + min_review; 'newest Deck-Verified games' → released_within_days + steam_deck. " +
        "No appids needed — unlike get_items, which prices a list you already have. " +
        "Note: the Steam catalog API has no release-date sort, so results are scanned popularity-first " +
        "and these filters are applied over that window — great for popular titles; a niche release " +
        "with very few reviews may fall outside the top `count` (raise count for stricter filters).",
      inputSchema: {
        released_after: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date, e.g. 2026-03-01.")
          .describe("Keep only games released on/after this date (YYYY-MM-DD).")
          .optional(),
        released_within_days: z
          .number()
          .int()
          .min(1)
          .describe("Alternative to released_after: released within the last N days.")
          .optional(),
        steam_deck: z
          .enum(["playable", "verified"])
          .describe(
            "Keep only Deck-capable games: 'verified' = Deck-Verified only; 'playable' = Playable or Verified.",
          )
          .optional(),
        min_review: z
          .number()
          .int()
          .min(0)
          .max(100)
          .describe("Minimum positive-review %, e.g. 85. Applied over the returned page.")
          .optional(),
        min_reviews: z
          .number()
          .int()
          .min(0)
          .describe("Minimum review count (filters out games with too few reviews).")
          .optional(),
        min_discount: z
          .number()
          .int()
          .min(1)
          .max(100)
          .describe(
            "Minimum discount %, e.g. 80 for '80%+ off' — this is the 'deals' filter. " +
              "Omit to include full-price games.",
          )
          .optional(),
        count: z
          .number()
          .int()
          .min(1)
          .max(200)
          .describe("How many catalog entries to scan (default 50). Raise for stricter filters.")
          .optional(),
        start: z.number().int().min(0).describe("Pagination offset into the catalog.").optional(),
        country: z
          .string()
          .regex(/^[A-Za-z]{2}$/, "Two-letter ISO country code.")
          .describe("Country (cc) for prices; overrides STEAM_COUNTRY.")
          .optional(),
        language: z
          .string()
          .min(2)
          .describe("Store language; overrides STEAM_LANGUAGE.")
          .optional(),
      },
      annotations: READ_ONLY,
    },
    ({
      released_after,
      released_within_days,
      steam_deck,
      min_review,
      min_reviews,
      min_discount,
      count,
      start,
      country,
      language,
    }) => {
      // Resolve the recency cutoff (unix seconds): explicit date wins, else a
      // rolling window of N days from now.
      let releasedAfter: number | undefined;
      if (released_after) releasedAfter = Math.floor(Date.parse(released_after) / 1000);
      else if (released_within_days)
        releasedAfter = Math.floor(Date.now() / 1000) - released_within_days * 86400;
      return reply(() =>
        web.discoverGames({
          releasedAfter,
          steamDeck: steam_deck,
          minReview: min_review,
          minReviews: min_reviews,
          minDiscount: min_discount,
          count,
          start,
          country,
          language,
        }),
      );
    },
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
    ({ steamid: id }) => reply(async () => web.getWishlist(await web.requireSteamId(id))),
  );

  // ---- player data (key required) -------------------------------------------

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
    "get_player_summary",
    {
      title: "Get player profile",
      description:
        "Get a player's public profile by SteamID64: display name, online state, country, account " +
        "age, and the game they're currently in. Requires STEAM_API_KEY and a public profile.",
      inputSchema: { steamid },
      annotations: READ_ONLY,
    },
    ({ steamid: id }) => requireKey(async () => web.getPlayerSummary(await web.requireSteamId(id))),
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
    ({ steamid: id }) => requireKey(async () => web.getOwnedGames(await web.requireSteamId(id))),
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
    ({ steamid: id }) =>
      requireKey(async () => web.getRecentlyPlayed(await web.requireSteamId(id))),
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
