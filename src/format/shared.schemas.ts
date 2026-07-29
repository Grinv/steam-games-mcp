// Zod fragment shared by every client-layer early-return that short-circuits
// before reaching a format/*.ts summarizer (a private profile/friends list,
// an empty owned-library, an unresolvable tag dictionary, ...). `.strict()`
// so an accidental extra field fails loudly at the construction site via
// `.parse()`, exactly like every summarizer below it in format/*.ts.
import { z } from "zod";

export const notFoundReason = z.object({ found: z.literal(false), reason: z.string() }).strict();

// Composes a tool's outputSchema from its not-found shape (usually
// `notFoundReason`, but e.g. get_wishlist uses `wishlistNotFound` instead) plus
// one or more found:true shapes — the "found:false ∪ found:true" union every
// tool with a not-found path needs, instead of each tools/*.ts call site
// hand-writing `z.union([...])` itself.
//
// The common case (exactly one `found` shape) uses a discriminated union on
// `found` — Zod validates by picking the matching branch directly instead of
// trying every member, and a mismatch reports which branch was expected. That
// requires each member to have a distinct `found` literal, which doesn't hold
// when get_wishlist passes two found:true shapes (light vs. detailed) — that
// case falls back to a plain union instead.
export function withNotFound<NotFound extends z.ZodTypeAny, Found extends z.ZodTypeAny>(
  notFound: NotFound,
  found: Found,
): z.ZodDiscriminatedUnion<[NotFound, Found], "found">;
export function withNotFound<
  NotFound extends z.ZodTypeAny,
  Found extends readonly [z.ZodTypeAny, ...z.ZodTypeAny[]],
>(notFound: NotFound, ...found: Found): z.ZodUnion<[NotFound, ...Found]>;
export function withNotFound(notFound: z.ZodTypeAny, ...found: z.ZodTypeAny[]) {
  if (found.length === 1) {
    // The overloads above are the real (checked) contract for callers; Zod's
    // own discriminatedUnion typing wants each member typed as discriminable
    // up front, which a generic z.ZodTypeAny parameter can't express here —
    // every actual caller passes an object with a `found` literal (enforced
    // by notFoundReason/gamesNotFound/wishlistNotFound and each *Found schema).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return z.discriminatedUnion("found", [notFound, found[0]!] as any);
  }
  return z.union([notFound, ...found]);
}

// The empty-wishlist shape is identical whether it came from the light
// summarizer (format/web.ts's summarizeWishlist) or the detailed one
// (format/store.ts's summarizeWishlistDetailed) — both check `items.length === 0`
// the same way, so both parse against this one shared fragment.
export const wishlistNotFound = z
  .object({
    found: z.literal(false),
    reason: z.string(),
    total: z.literal(0),
    items: z.array(z.never()),
  })
  .strict();

// Same shape as wishlistNotFound but keyed `games` instead of `items` — shared
// by summarizeRecentlyPlayed and summarizeFollowedGames (format/web.ts), which
// both check an empty appid/game list the same way.
export const gamesNotFound = z
  .object({
    found: z.literal(false),
    reason: z.string(),
    total: z.literal(0),
    games: z.array(z.never()),
  })
  .strict();
