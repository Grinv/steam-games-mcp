// Zod schemas for format/web.ts's summarizers. Each exported summarizer builds
// its return value via `schema.parse({...})` (see web.ts), so the schema is
// the single source of truth for its shape — see storefront.schemas.ts for the
// full rationale. `.strict()` throughout. Several tools' `found:false` branches
// are actually thrown by the CLIENT layer (clients/web.ts, clients/storeService.ts)
// before a summarizer ever runs (a private profile/friends list, an empty
// owned-library, ...) — those parse against the shared `notFoundReason`
// fragment (format/shared.schemas.ts) at their own construction site, not here.
import { z } from "zod";
import { gamesNotFound } from "./shared.schemas.js";

export const getPlayerSummaryOutput = z.union([
  z.object({ found: z.literal(false) }).strict(),
  z
    .object({
      found: z.literal(true),
      steamid: z.string().optional(),
      name: z.string().nullable(),
      real_name: z.string().nullable(),
      state: z.string(),
      visibility: z.enum(["public", "private"]),
      country: z.string().nullable(),
      level: z.number().nullable(),
      created: z.string().nullable(),
      in_game: z.string().nullable(),
      profile_url: z.string().nullable(),
      avatar: z.string().nullable(),
    })
    .strict(),
]);

const ownedGame = z
  .object({
    appid: z.number().optional(),
    name: z.string().nullable(),
    playtime_hours: z.number().nullable(),
    playtime_2weeks_hours: z.number().nullable(),
  })
  .strict();
export const getOwnedGamesOutput = z.union([
  z
    .object({
      found: z.literal(false),
      reason: z.string(),
      game_count: z.null(),
      games: z.array(z.never()),
      owns: z.array(z.object({ appid: z.number(), owned: z.literal(false) }).strict()).optional(),
    })
    .strict(),
  z
    .object({
      found: z.literal(true),
      game_count: z.number(),
      returned: z.number(),
      games: z.array(ownedGame),
      owns: z
        .array(
          z
            .object({
              appid: z.number(),
              owned: z.boolean(),
              playtime_hours: z.number().nullable(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict(),
]);

export const comparePlayersFound = z
  .object({
    found: z.literal(true),
    shared_count: z.number(),
    returned: z.number(),
    games: z.array(
      z
        .object({
          appid: z.number().optional(),
          name: z.string().nullable(),
          playtime_hours_a: z.number().nullable(),
          playtime_hours_b: z.number().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const getRecentlyPlayedOutput = z.union([
  gamesNotFound,
  z
    .object({
      found: z.literal(true),
      total: z.number(),
      games: z.array(ownedGame),
    })
    .strict(),
]);

export const playerAchievementsFound = z
  .object({
    found: z.literal(true),
    game: z.string().nullable(),
    total: z.number(),
    unlocked: z.number(),
    completion_pct: z.number().nullable(),
    returned: z.number(),
    achievements: z.array(
      z
        .object({
          name: z.string().optional(),
          achieved: z.boolean(),
          unlocked_at: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const getGlobalAchievementsOutput = z
  .object({
    count: z.number(),
    returned: z.number(),
    achievements: z.array(
      z.object({ name: z.string().optional(), percent: z.number().nullable() }).strict(),
    ),
  })
  .strict();

export const getGameAchievementsOutput = z
  .object({
    game: z.string().nullable(),
    total: z.number(),
    returned: z.number(),
    achievements: z.array(
      z
        .object({
          api_name: z.string().optional(),
          name: z.string().nullable(),
          description: z.string().nullable(),
          hidden: z.boolean(),
          global_unlock_pct: z.number().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const getGameNewsOutput = z
  .object({
    items: z.array(
      z
        .object({
          title: z.string().nullable(),
          date: z.string().nullable(),
          author: z.string().nullable(),
          feed: z.string().nullable(),
          excerpt: z.string().nullable(),
          url: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const vanityFound = z.object({ found: z.literal(true), steamid: z.string() }).strict();

export const getCurrentPlayersOutput = z
  .object({
    appid: z.number(),
    player_count: z.number().nullable(),
  })
  .strict();

// get_wishlist's LIGHT success shape (no include_details/filters). The
// not-found branch (empty/private wishlist) is the shared `wishlistNotFound`
// fragment (format/shared.schemas.ts) — identical to the detailed summarizer's.
export const wishlistLightFound = z
  .object({
    found: z.literal(true),
    total: z.number(),
    returned: z.number(),
    items: z.array(
      z
        .object({
          appid: z.number().optional(),
          store_url: z.string().nullable(),
          priority: z.number().nullable(),
          added: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const getPlayerBansOutput = z.union([
  z.object({ found: z.literal(false) }).strict(),
  z
    .object({
      found: z.literal(true),
      steamid: z.string().optional(),
      vac_banned: z.boolean(),
      vac_ban_count: z.number(),
      game_ban_count: z.number(),
      community_banned: z.boolean(),
      economy_ban: z.string().nullable(),
      days_since_last_ban: z.number().nullable(),
    })
    .strict(),
]);

export const getFollowedGamesOutput = z.union([
  gamesNotFound,
  z
    .object({
      found: z.literal(true),
      total: z.number(),
      returned: z.number(),
      games: z.array(z.object({ appid: z.number(), store_url: z.string().nullable() }).strict()),
    })
    .strict(),
]);

// summarizeFriendList never returns found:false itself — the client layer
// (clients/web.ts's #friendsRaw) short-circuits to the shared `notFoundReason`
// fragment before this ever runs, for a private friends list.
export const friendListFound = z
  .object({
    found: z.literal(true),
    total: z.number(),
    returned: z.number(),
    friends: z.array(
      z
        .object({
          steamid: z.string().optional(),
          name: z.string().nullable(),
          state: z.string(),
          in_game: z.string().nullable(),
          profile_url: z.string().nullable(),
          friends_since: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

// Same story as friendListFound: the client layer handles the private-list
// found:false case before summarizeFriendsWhoOwn ever runs.
const friendNameEntry = z.object({ steamid: z.string(), name: z.string().nullable() }).strict();
export const findFriendsWhoOwnFound = z
  .object({
    found: z.literal(true),
    total_friends: z.number(),
    matches: z.array(
      z
        .object({
          appid: z.number(),
          owners: z.array(friendNameEntry.extend({ playtime_hours: z.number().nullable() })),
        })
        .strict(),
    ),
    private_friends: z.array(friendNameEntry),
    // A friend whose own GetOwnedGames call failed (rate-limited/network/
    // timeout/5xx) rather than came back private — see summarizeFriendsWhoOwn.
    unavailable_friends: z.array(friendNameEntry.extend({ reason: z.string() })),
  })
  .strict();
