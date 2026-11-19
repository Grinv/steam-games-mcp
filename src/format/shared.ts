// Generic field helpers shared by the storefront and web formatters. Pure,
// dependency-free transforms used to keep tool responses token-efficient.
import { ApiError } from "../lib/errors.ts";
import { notFoundReason } from "./shared.schemas.ts";
import { z } from "zod";

// A Steam body that doesn't fit its input schema: unusable, never a verdict.
// Retryable like every unusable body (it states nothing about the game or
// player), so a stale copy can answer it. One line (the log shows a message's
// first line): where and what, per issue.
export function unusableBody(what: string, error: z.ZodError): ApiError {
  const why = error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  return new ApiError({
    code: "bad_response",
    message: `${what}: ${why}`,
    retryable: true,
    cause: error,
  });
}

// An endpoint's body rule (clients/endpoints.ts's `validate`) from the
// response's input schema: the body is used only when it parses, so the
// fields the schema requires are there, as the type derived from it says.
// The schema checks only those and the objects on their path; the rest is
// `unchecked`.
export function bodyRule(schema: z.ZodType, what: string): (body: unknown) => void {
  return (body) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw unusableBody(what, parsed.error);
  };
}

// Typed, not checked: Steam's optional fields and list elements are
// hand-written types never verified live. Only a body rule's required fields
// are checked, so one odd item can't cost the whole body.
export const unchecked = <T>() => z.custom<T>();

// The client layer (clients/web.ts, clients/storeService.ts) short-circuits to
// found:false before a summarizer ever runs (a private profile/friends list,
// an empty owned-library, an unresolvable tag dictionary, ...) — routing that
// through this helper keeps the actual shaping (the `.parse()` call) inside
// format/, per AGENTS.md's "all raw→agent-facing shaping lives in src/format/".
export function notFound(reason: string): z.infer<typeof notFoundReason> {
  return notFoundReason.parse({ found: false, reason });
}

// What Steam returned when it didn't show a player's data — never a guessed
// cause. Steam answers alike for situations it doesn't tell apart (its 403
// "Profile is not public" covers a private profile, private game details, a
// game the player doesn't own and an account that doesn't exist — all
// recorded in clients/endpoints.ts), so the agent gets the tools that
// establish which, not one of them picked for it.
export function notShown(what: string, ...howToTell: string[]): string {
  return [
    `Steam didn't return ${what}.`,
    "To narrow down why: get_player_summary (needs STEAM_API_KEY) shows whether the account " +
      "exists and whether its profile is public (game details, the friends list and the " +
      "wishlist have their own privacy settings, which nothing shows).",
    ...howToTell,
  ].join(" ");
}

// The two tools that read a profile regardless of its privacy setting
// (get_player_summary, get_player_bans) can only fail one way, so they say which
// one instead of returning a bare found:false an agent could read as "private".
export const NO_SUCH_ACCOUNT_REASON =
  "No Steam account with that SteamID64. This tool works on private profiles too, " +
  "so this is not a privacy setting — double-check the id, or resolve a vanity name " +
  "with resolve_vanity_url.";

export function names(list: { description?: string; name?: string }[] | undefined): string[] {
  // Dedup: Steam repeats entries in some lists (e.g. a game's `categories`
  // carries "Steam Workshop"/controller-support labels twice), which would
  // otherwise leak duplicates into get_game's genres/categories.
  return [
    ...new Set(
      (list ?? []).map((x) => x.description ?? x.name).filter((n): n is string => Boolean(n)),
    ),
  ];
}

// Steam stores playtime in minutes; expose hours (1dp) which agents reason about.
export function hours(minutes: number | undefined): number | null {
  return typeof minutes === "number" ? Math.round((minutes / 60) * 10) / 10 : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
// Steam's text fields arrive HTML-escaped (Portal 2's short_description:
// `The &quot;Perpetual Testing Initiative&quot;`). One pass, so `&amp;quot;`
// decodes to the literal `&quot;` it encodes rather than to `"`. Unknown
// entities are left as they are.
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

// Strip HTML tags from store descriptions / requirements blobs, then decode
// entities (after, so an escaped `&lt;b&gt;` stays text instead of becoming a
// tag to strip).
export function stripHtml(s: string | undefined): string | null {
  if (!s) return null;
  return (
    decodeEntities(s.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

// Format raw price cents (+ optional currency) into a compact label.
export function money(
  cents: number | undefined | null,
  currency: string | undefined,
): string | null {
  if (typeof cents !== "number") return null;
  const v = (cents / 100).toFixed(2);
  return currency ? `${v} ${currency}` : v;
}

// Unix seconds → ISO date (YYYY-MM-DD), or null.
export function isoDay(ts: number | undefined): string | null {
  return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null;
}

// A store release timestamp → the calendar date the Steam store shows for it.
// Valve stamps release dates in Pacific time, so the UTC day of the timestamp
// is a day late for anything released after ~16:00 PT: Portal 2's
// 1303186800 is 2011-04-19 04:20 UTC, and the store page says Apr 18, 2011.
// Assembled from parts rather than trusting a locale's own YYYY-MM-DD layout.
const PACIFIC_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function storeReleaseDay(ts: number | undefined): string | null {
  if (!ts) return null;
  const part = Object.fromEntries(
    PACIFIC_DAY.formatToParts(new Date(ts * 1000)).map((p) => [p.type, p.value]),
  );
  return `${part.year}-${part.month}-${part.day}`;
}

/** Unix seconds at which a store calendar day (YYYY-MM-DD) begins, i.e. its
 *  Pacific midnight — the cutoff matching storeReleaseDay(), so a game shown
 *  with release_date D always passes a released_after of D and never one of
 *  D+1. Pacific midnight is 07:00 or 08:00 UTC depending on DST. */
export function storeDayStart(day: string): number {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`) / 1000;
  for (const h of [7, 8]) {
    const t = utcMidnight + h * 3600;
    if (storeReleaseDay(t) === day && storeReleaseDay(t - 1) !== day) return t;
  }
  return utcMidnight + 8 * 3600; // unreachable for a real date; PST as a fallback
}

// Unix seconds → full ISO 8601 UTC (e.g. 2026-07-09T17:00:00Z), or null. Used
// where the time of day matters (e.g. when a discount ends), not just the date.
export function isoDateTime(ts: number | undefined): string | null {
  return ts ? new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

// Clickable Steam store page URL for an appid. The bare /app/<id> form is enough —
// Steam redirects it to the full title-slug page — so no slug is needed.
export function storeUrl(appid: number | undefined): string | null {
  return typeof appid === "number" ? `https://store.steampowered.com/app/${appid}` : null;
}

// Cap a list to `max` items, reporting how many are included alongside the
// true total (`items.length` — callers keep that for their own `total`/`count`
// field). One shared shape for every collection-returning summarizer that
// trims a big list for token efficiency, instead of each hand-rolling its own
// slice + `Math.min`/`.length` bookkeeping.
export function capList<T>(items: T[], max: number): { included: T[]; returned: number } {
  return { included: items.slice(0, max), returned: Math.min(items.length, max) };
}
