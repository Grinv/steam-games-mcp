// Zod schemas for format/web.ts's summarizers. Each exported summarizer builds
// its return value via `schema.parse({...})` (see web.ts), so the schema is
// the single source of truth for its shape — see storefront.schemas.ts for the
// full rationale. (The three achievement-list schemas live in their own
// co-located webAchievements.schemas.ts alongside format/webAchievements.ts.)
// `z.strictObject()` throughout. Several tools' `found:false` branches
// are actually thrown by the CLIENT layer (clients/web.ts, clients/storeService.ts)
// before a summarizer ever runs (a private profile/friends list, an empty
// owned-library, ...) — those parse against the shared `notFoundReason`
// fragment (format/shared.schemas.ts) at their own construction site, not here.
import { z } from "zod";
import { gamesNotFound } from "./shared.schemas.js";

// Steam's `personastate` is a small fixed index (0-6, per the Web API docs);
// format/web.ts's summarizers map it through this same list, so the two
// can't silently drift.
export const personaStates = [
  "offline",
  "online",
  "busy",
  "away",
  "snooze",
  "looking to trade",
  "looking to play",
] as const;

// format/web.ts's summarizePlayer maps communityvisibilitystate to one of these
// via this same schema's .enum, so the label set lives in one place.
export const visibilitySchema = z.enum(["public", "private"]);

export const getPlayerSummaryOutput = z.discriminatedUnion("found", [
  z.strictObject({ found: z.literal(false) }),
  z.strictObject({
    found: z.literal(true),
    steamid: z.string().optional(),
    name: z.string().nullable(),
    real_name: z.string().nullable(),
    state: z.enum(personaStates),
    visibility: visibilitySchema,
    country: z.string().nullable(),
    level: z.number().nullable(),
    created: z.string().nullable(),
    in_game: z.string().nullable(),
    profile_url: z.string().nullable(),
    avatar: z.string().nullable(),
  }),
]);

const ownedGame = z.strictObject({
  appid: z.number().optional(),
  name: z.string().nullable(),
  playtime_hours: z.number().nullable(),
  playtime_2weeks_hours: z.number().nullable(),
});
export const getOwnedGamesOutput = z.discriminatedUnion("found", [
  z.strictObject({
    found: z.literal(false),
    reason: z.string(),
    game_count: z.null(),
    games: z.array(z.never()),
    owns: z.array(z.strictObject({ appid: z.number(), owned: z.literal(false) })).optional(),
  }),
  z.strictObject({
    found: z.literal(true),
    game_count: z.number(),
    returned: z.number(),
    games: z.array(ownedGame),
    owns: z
      .array(
        z.strictObject({
          appid: z.number(),
          owned: z.boolean(),
          playtime_hours: z.number().nullable(),
        }),
      )
      .optional(),
  }),
]);

export const comparePlayersFound = z.strictObject({
  found: z.literal(true),
  shared_count: z.number(),
  returned: z.number(),
  games: z.array(
    z.strictObject({
      appid: z.number().optional(),
      name: z.string().nullable(),
      playtime_hours_a: z.number().nullable(),
      playtime_hours_b: z.number().nullable(),
    }),
  ),
});

export const getRecentlyPlayedOutput = z.discriminatedUnion("found", [
  gamesNotFound,
  z.strictObject({
    found: z.literal(true),
    total: z.number(),
    games: z.array(ownedGame),
  }),
]);

export const getGameNewsOutput = z.strictObject({
  items: z.array(
    z.strictObject({
      title: z.string().nullable(),
      date: z.string().nullable(),
      author: z.string().nullable(),
      feed: z.string().nullable(),
      excerpt: z.string().nullable(),
      url: z.string().nullable(),
    }),
  ),
});

export const vanityFound = z.strictObject({ found: z.literal(true), steamid: z.string() });

export const getCurrentPlayersOutput = z.strictObject({
  appid: z.number(),
  player_count: z.number().nullable(),
});

// get_wishlist's LIGHT success shape (no include_details/filters). The
// not-found branch (empty/private wishlist) is the shared `wishlistNotFound`
// fragment (format/shared.schemas.ts) — identical to the detailed summarizer's.
export const wishlistLightFound = z.strictObject({
  found: z.literal(true),
  total: z.number(),
  returned: z.number(),
  items: z.array(
    z.strictObject({
      appid: z.number().optional(),
      store_url: z.string().nullable(),
      priority: z.number().nullable(),
      added: z.string().nullable(),
    }),
  ),
});

export const getPlayerBansOutput = z.discriminatedUnion("found", [
  z.strictObject({ found: z.literal(false) }),
  z.strictObject({
    found: z.literal(true),
    steamid: z.string().optional(),
    vac_banned: z.boolean(),
    vac_ban_count: z.number(),
    game_ban_count: z.number(),
    community_banned: z.boolean(),
    economy_ban: z.string().nullable(),
    days_since_last_ban: z.number().nullable(),
  }),
]);

export const getFollowedGamesOutput = z.discriminatedUnion("found", [
  gamesNotFound,
  z.strictObject({
    found: z.literal(true),
    total: z.number(),
    returned: z.number(),
    games: z.array(z.strictObject({ appid: z.number(), store_url: z.string().nullable() })),
  }),
]);

// summarizeFriendList never returns found:false itself — the client layer
// (clients/web.ts's #friendsRaw) short-circuits to the shared `notFoundReason`
// fragment before this ever runs, for a private friends list.
export const friendListFound = z.strictObject({
  found: z.literal(true),
  total: z.number(),
  returned: z.number(),
  friends: z.array(
    z.strictObject({
      steamid: z.string().optional(),
      name: z.string().nullable(),
      state: z.enum(personaStates),
      in_game: z.string().nullable(),
      profile_url: z.string().nullable(),
      friends_since: z.string().nullable(),
    }),
  ),
});

// Same story as friendListFound: the client layer handles the private-list
// found:false case before summarizeFriendsWhoOwn ever runs.
const friendNameEntry = z.strictObject({ steamid: z.string(), name: z.string().nullable() });
export const findFriendsWhoOwnFound = z.strictObject({
  found: z.literal(true),
  total_friends: z.number(),
  matches: z.array(
    z.strictObject({
      appid: z.number(),
      owners: z.array(friendNameEntry.extend({ playtime_hours: z.number().nullable() })),
      // Present (and > owners.length) only when the owner list was capped.
      owners_total: z.number().optional(),
    }),
  ),
  private_friends: z.array(friendNameEntry),
  private_friends_total: z.number().optional(),
  // A friend whose own GetOwnedGames call failed (rate-limited/network/
  // timeout/5xx) rather than came back private — see summarizeFriendsWhoOwn.
  unavailable_friends: z.array(friendNameEntry.extend({ reason: z.string() })),
  unavailable_friends_total: z.number().optional(),
});
