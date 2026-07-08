// Steam Web API tools. Player tools (profile, library, achievements, vanity)
// require a free key (STEAM_API_KEY); they short-circuit with a clear message
// when it's missing. News and global achievement % are exposed without that
// gate since Steam currently serves them keyless (a key is still sent if set).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SteamWebClient } from "../clients/web.js";
import { errorResult, type ToolResult } from "../lib/result.js";
import {
  READ_ONLY,
  appid,
  country,
  language,
  platform,
  reply,
  steamDeck,
  steamFrame,
  steamOs,
} from "./common.js";

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
        "Get price/discount, review % (positive), hardware compatibility, popular user tags and " +
        "release date for a LIST of games by appid in ONE keyless call. The efficient way to price-, " +
        "rating-, tag- and compat-check a wishlist or library without a request per game. Each item " +
        "carries three compatibility fields, each verified/playable/unsupported/unknown: steam_deck " +
        "(Steam Deck), steam_os (SteamOS — any SteamOS device incl. the Steam Machine), and " +
        "steam_frame (Steam Frame VR headset); a `tags` list (top user tags like 'Roguelike', " +
        "'Souls-like', most-relevant first); a clickable `store_url` to the game's Steam page; and, " +
        "when on sale, `discount_end` (ISO UTC time the discount expires — for 'how long is this deal " +
        "valid'). Get appids from search_games / get_wishlist / get_owned_games.",
      inputSchema: {
        appids: z
          .array(z.number().int().positive())
          .min(1)
          .max(100)
          .describe("Steam appids (1-100)."),
        country,
        language,
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
        "released_within_days — for 'new games'), hardware compatibility (steam_deck for Steam Deck, " +
        "steam_os for SteamOS / the Steam Machine, steam_frame for the Steam Frame VR headset), " +
        "native OS build (platform — windows/mac/linux), review quality (min_review / min_reviews), " +
        "and user tags (tags — e.g. ['Roguelike', " +
        "'Deckbuilding'] for 'games like X'). Each result returns price/discount, review %, all three " +
        "compat statuses, popular tags, a clickable store_url, discount_end (when a deal expires) and " +
        "release date in one call. Examples: '>80% off with 90%+ " +
        "reviews' → set min_discount + min_review; 'recent well-reviewed games that run on Steam Deck' " +
        "→ set released_within_days + steam_deck + min_review; 'roguelike deckbuilders on sale' → " +
        "tags:['Roguelike','Deckbuilding'] + min_discount; 'games that run on the Steam Machine / " +
        "SteamOS' → steam_os. No appids needed — unlike get_items, which prices a list you already have. " +
        "Note: the Steam catalog API has no release-date/tag sort or filter, so results are scanned " +
        "popularity-first and the recency, compat and tag filters are applied over that window — great " +
        "for popular titles; a niche match may fall outside the top `count` (raise count for stricter filters).",
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
        steam_deck: steamDeck,
        steam_os: steamOs,
        steam_frame: steamFrame,
        platform,
        tags: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Keep only games carrying ALL of these user tags (case-insensitive), e.g. " +
              "['Roguelike','Deckbuilding']. Use exact Steam tag names. Applied over the scanned " +
              "popularity window, so raise `count` when combining niche tags.",
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
        country,
        language,
      },
      annotations: READ_ONLY,
    },
    ({
      released_after,
      released_within_days,
      steam_deck,
      steam_os,
      steam_frame,
      platform: plat,
      tags,
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
          steamOs: steam_os,
          steamFrame: steam_frame,
          platform: plat,
          tags,
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
        "List a player's Steam wishlist by SteamID64. Works without a key, but only if that player's " +
        "wishlist/profile is public — otherwise it returns found:false. By default returns a light " +
        "list of appids (sorted by priority, no names). Set include_details for full store cards in " +
        "ONE call (name, price/discount, review %, Deck/SteamOS/Frame compat, tags, release) — no " +
        "need to follow up with get_items. Narrow it in the SAME call with tags (e.g. " +
        "['Metroidvania']), platform (NATIVE windows/mac/linux build), steam_deck / steam_os / " +
        "steam_frame (Proton compatibility — distinct from a native build), min_review and " +
        "min_discount / on_sale_only, or country / language (the light appid list carries no price, " +
        "so setting either implies include_details too) — these are applied over the " +
        "WHOLE wishlist before the output cap, so a deeply-discounted niche match is never hidden by " +
        "the cap (e.g. 'top metroidvanias on my wishlist with a good discount and reviews' → " +
        "tags:['Metroidvania'] + min_discount + min_review). Results ranked by discount when a " +
        "discount filter is set, else by wishlist priority; `matched` reports the pre-cap count. " +
        "Convert a vanity name with resolve_vanity_url first.",
      inputSchema: {
        steamid,
        include_details: z
          .boolean()
          .describe(
            "Return full store cards (name, price, discount, reviews, compatibility, tags) per item " +
              "in one call, instead of just appids. Implied by any filter below.",
          )
          .optional(),
        on_sale_only: z
          .boolean()
          .describe(
            "Only wishlist items currently discounted, ranked by discount %. Implies include_details.",
          )
          .optional(),
        tags: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Keep only wishlist items carrying ALL of these user tags (case-insensitive), e.g. " +
              "['Metroidvania']. Implies include_details.",
          )
          .optional(),
        min_review: z
          .number()
          .int()
          .min(0)
          .max(100)
          .describe(
            "Keep only items with at least this positive-review %. Implies include_details.",
          )
          .optional(),
        min_discount: z
          .number()
          .int()
          .min(1)
          .max(100)
          .describe(
            "Keep only items discounted at least this %, ranked by discount. Implies include_details.",
          )
          .optional(),
        platform,
        steam_deck: steamDeck,
        steam_os: steamOs,
        steam_frame: steamFrame,
        country: country.describe(
          "Country (cc) for prices; overrides STEAM_COUNTRY. Only meaningful for store cards, so " +
            "setting it implies include_details — the light appid list carries no price.",
        ),
        language: language.describe(
          "Store language; overrides STEAM_LANGUAGE. Only meaningful for store cards, so setting it " +
            "implies include_details — the light appid list carries no price.",
        ),
      },
      annotations: READ_ONLY,
    },
    ({
      steamid: id,
      include_details,
      on_sale_only,
      tags,
      min_review,
      min_discount,
      platform: plat,
      steam_deck,
      steam_os,
      steam_frame,
      country,
      language,
    }) =>
      reply(async () => {
        const sid = await web.requireSteamId(id);
        // Any filter (or an explicit flag) switches to the enriched card view.
        // country/language are included here too — the light appid list carries
        // no price, so those params are a no-op unless detailed mode is on.
        const detailed =
          include_details ||
          on_sale_only ||
          [
            tags,
            min_review,
            min_discount,
            plat,
            steam_deck,
            steam_os,
            steam_frame,
            country,
            language,
          ].some((v) => v !== undefined);
        return detailed
          ? web.getWishlistDetailed(sid, {
              onSaleOnly: on_sale_only,
              tags,
              minReview: min_review,
              minDiscount: min_discount,
              platform: plat,
              steamDeck: steam_deck,
              steamOs: steam_os,
              steamFrame: steam_frame,
              country,
              language,
            })
          : web.getWishlist(sid);
      }),
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
