// Keyless-capable Steam Web API tools: news, global achievement %, current
// players, and the modern store-service card tools (get_items, discover_games,
// get_wishlist, get_followed_games). All work without STEAM_API_KEY; the key is
// still sent when present (see AGENTS.md's keyless caveat). Split out of a single
// tools/web.ts once it grew past ~550 lines — see tools/webPlayer.ts for the
// key-required half.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { SteamWebClient } from "../clients/web.js";
import type { StoreServiceClient } from "../clients/storeService.js";
import {
  READ_ONLY,
  appid,
  country,
  language,
  platform,
  reply,
  steamDeck,
  steamFrame,
  steamMachine,
  steamOs,
} from "./common.js";
import { steamid, steamIdTool } from "./webShared.js";
import { wishlistNotFound, withNotFound } from "../format/shared.schemas.js";
import { ACHIEVEMENTS_MAX } from "../format/web.js";
import {
  discoverGamesOutput,
  getItemsOutput,
  wishlistDetailedFound,
} from "../format/store.schemas.js";
import {
  getCurrentPlayersOutput,
  getFollowedGamesOutput,
  getGameNewsOutput,
  getGlobalAchievementsOutput,
  wishlistLightFound,
} from "../format/web.schemas.js";

// get_wishlist dispatches to the light summarizer (format/web.ts) or the
// detailed one (format/store.ts) depending on the given filters — this union
// is assembled here (not in either format/*.schemas.ts) since this is the one
// layer that knows about both paths.
const getWishlistOutput = withNotFound(wishlistNotFound, wishlistLightFound, wishlistDetailedFound);

export function registerStoreWebTools(
  server: McpServer,
  web: SteamWebClient,
  store: StoreServiceClient,
): void {
  server.registerTool(
    "get_game_news",
    {
      title: "Get game news",
      description:
        "Get recent news / patch notes for a game by appid (title, date, author, excerpt, link). " +
        "Get the appid from search_games. Works without an API key.",
      inputSchema: z.object({
        appid,
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .describe("How many news items (1-20). Default 5.")
          .optional(),
      }),
      outputSchema: getGameNewsOutput,
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
        "achievement is across all players. Returns each achievement's internal name and its unlock " +
        "percent (no display names/descriptions — for those, use get_game_achievements), most-common " +
        `first, capped at the first ${ACHIEVEMENTS_MAX} (check ` +
        "`returned` vs `count` — most games have far fewer). " +
        "Get the appid from search_games. Works without a key.",
      inputSchema: z.object({ appid }),
      outputSchema: getGlobalAchievementsOutput,
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
        "rating-, tag- and compat-check a wishlist or library without a request per game. For a bigger " +
        "batch (up to 500 appids) when you only need price, use get_prices instead. Each item " +
        "carries four compatibility fields, each verified/playable/unsupported/unknown: steam_deck " +
        "(Steam Deck), steam_os (SteamOS in general), steam_machine (the Steam Machine console " +
        "specifically), and steam_frame (Steam Frame VR headset); a `vr_support` flag " +
        "(none/supported/required — distinct from steam_frame, which is a Steam Frame HARDWARE compat " +
        "rating, not whether the game itself has a VR mode); a `tags` list (top user tags like 'Roguelike', " +
        "'Souls-like', most-relevant first); a clickable `store_url` to the game's Steam page; and, " +
        "when on sale, `discount_end` (ISO UTC time the discount expires — for 'how long is this deal " +
        "valid'). Get appids from search_games / get_wishlist / get_owned_games.",
      inputSchema: z.object({
        appids: z
          .array(z.number().int().positive())
          .min(1)
          .max(100)
          .describe("Steam appids (1-100)."),
        country,
        language,
      }),
      outputSchema: getItemsOutput,
      annotations: READ_ONLY,
    },
    ({ appids, country, language }) => reply(() => store.getItems(appids, country, language)),
  );

  server.registerTool(
    "discover_games",
    {
      title: "Discover games (deals, new releases, Steam Deck, rating)",
      description:
        "Find games across the whole Steam catalog (keyless), filtered by ANY combination of: " +
        "discount (min_discount — for 'what's on sale'), release recency (released_after / " +
        "released_within_days — for 'new games'), hardware compatibility (steam_deck for Steam Deck, " +
        "steam_os for SteamOS in general, steam_machine for the Steam Machine console specifically, " +
        "steam_frame for the Steam Frame VR headset), " +
        "native OS build (platform — windows/mac/linux), review quality (min_review / min_reviews), " +
        "and user tags (tags — e.g. ['Roguelike', " +
        "'Deckbuilding'] for 'games like X'). Each result returns price/discount, review %, all four " +
        "compat statuses, a vr_support flag (none/supported/required), popular tags, a clickable " +
        "store_url, discount_end (when a deal expires) and release date in one call. Examples: '>80% off with 90%+ " +
        "reviews' → set min_discount + min_review; 'recent well-reviewed games that run on Steam Deck' " +
        "→ set released_within_days + steam_deck + min_review; 'roguelike deckbuilders on sale' → " +
        "tags:['Roguelike','Deckbuilding'] + min_discount; 'games that run on the Steam Machine' → " +
        "steam_machine; 'games that run on SteamOS' → steam_os. " +
        "No appids needed — unlike get_items, which prices a list you already have. For 'games like " +
        "X' from a SINGLE named title, get its tags via get_items and pass them here; for taste " +
        "inferred from the player's WHOLE library instead, use get_recommended_games (key-gated). " +
        "Note: min_discount is filtered server-side, and setting released_after/released_within_days " +
        "also excludes not-yet-released games server-side — but the actual date cutoff, plus compat, " +
        "platform, review and tag filtering, have no server-side support in the Steam catalog API, so " +
        "those are scanned popularity-first and applied afterward over that same window — great for " +
        "popular titles; a niche match may fall outside the top `count` (raise count for stricter " +
        "filters).",
      inputSchema: z.object({
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
        steam_machine: steamMachine,
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
      }),
      outputSchema: discoverGamesOutput,
      annotations: READ_ONLY,
    },
    ({
      released_after,
      released_within_days,
      steam_deck,
      steam_os,
      steam_machine,
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
        store.discoverGames({
          releasedAfter,
          steamDeck: steam_deck,
          steamOs: steam_os,
          steamMachine: steam_machine,
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
        "Get the appid from search_games. Works without a key. Errors clearly if the appid is unknown/invalid " +
        "rather than returning a null count.",
      inputSchema: z.object({ appid }),
      outputSchema: getCurrentPlayersOutput,
      annotations: READ_ONLY,
    },
    ({ appid: id }) => reply(() => web.getCurrentPlayers(id)),
  );

  server.registerTool(
    "get_followed_games",
    {
      title: "Get a player's followed games",
      description:
        "List the games a player 'follows' on the Steam store, by SteamID64 — a lighter opt-in " +
        "(get sale/update notifications) that's separate from the wishlist; many players follow more " +
        "games than they wishlist. Works without a key, but only if that player's follows/profile are " +
        "public — otherwise it returns found:false. Returns appids + store_url only (no price/name); " +
        "pass the appids to get_items for price, review % and compat. Convert a vanity name with " +
        "resolve_vanity_url first.",
      inputSchema: z.object({ steamid }),
      outputSchema: getFollowedGamesOutput,
      annotations: READ_ONLY,
    },
    steamIdTool(web, reply, (sid) => web.getFollowedGames(sid)),
  );

  server.registerTool(
    "get_wishlist",
    {
      title: "Get a player's wishlist",
      description:
        "List a player's Steam wishlist by SteamID64. Works without a key, but only if that player's " +
        "wishlist/profile is public — otherwise it returns found:false. By default returns a light " +
        "list of appids (sorted by priority, no names). Set include_details for full store cards in " +
        "ONE call (name, price/discount, review %, Deck/SteamOS/Machine/Frame compat, vr_support, tags, release) — " +
        "no need to follow up with get_items. Narrow it in the SAME call with tags (e.g. " +
        "['Metroidvania']), platform (NATIVE windows/mac/linux build), steam_deck / steam_os / " +
        "steam_machine / steam_frame (Proton compatibility — distinct from a native build), min_review and " +
        "min_discount / on_sale_only, or country / language (the light appid list carries no price, " +
        "so setting either implies include_details too) — these are applied before the output cap " +
        "(the detailed card list returns at most 60 items), so a deeply-discounted niche match past " +
        "the display cap is never hidden by it (e.g. 'top " +
        "metroidvanias on my wishlist with a good discount and reviews' → tags:['Metroidvania'] + " +
        "min_discount + min_review). Results ranked by discount when a discount filter is set, else " +
        "by wishlist priority; `matched` reports the pre-cap count. Steam itself only attaches store " +
        "data to roughly the first 100 wishlist entries per call — on a bigger wishlist, `enriched` " +
        "reports how many of `total` got checked, and `note` explains when some were skipped (their " +
        "filter/price data isn't available at all, not that they don't match). Convert a vanity name " +
        "with resolve_vanity_url first.",
      inputSchema: z.object({
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
        steam_machine: steamMachine,
        steam_frame: steamFrame,
        country: country.describe(
          "Country (cc) for prices; overrides STEAM_COUNTRY. Only meaningful for store cards, so " +
            "setting it implies include_details — the light appid list carries no price.",
        ),
        language: language.describe(
          "Store language; overrides STEAM_LANGUAGE. Only meaningful for store cards, so setting it " +
            "implies include_details — the light appid list carries no price.",
        ),
      }),
      outputSchema: getWishlistOutput,
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
      steam_machine,
      steam_frame,
      country,
      language,
    }) =>
      reply(async () => {
        const sid = await web.requireSteamId(id);
        return web.getWishlist(sid, {
          includeDetails: include_details,
          onSaleOnly: on_sale_only,
          tags,
          minReview: min_review,
          minDiscount: min_discount,
          platform: plat,
          steamDeck: steam_deck,
          steamOs: steam_os,
          steamMachine: steam_machine,
          steamFrame: steam_frame,
          country,
          language,
        });
      }),
  );
}
