// Shared building blocks for the two Steam Web API tool registrations
// (webStore.ts: keyless-capable; webPlayer.ts: key-required) — split out of a
// single tools/web.ts once it grew past ~550 lines. Kept separate from
// tools/common.ts, which stays domain-agnostic (shared with tools/storefront.ts
// too) — `steamid` and the steamid-resolving helper below are Web-API-specific.
import { z } from "zod";
import { errorResult, type ToolResult } from "../lib/result.js";
import { reply } from "./common.js";

// Gates every key-required player tool on STEAM_API_KEY being set; one clear
// message instead of a round-trip 403. Lives here (not as a private closure
// inside webPlayer.ts) so "what happens when the key is missing" is
// discoverable next to this file's other Web-API-specific building blocks —
// `web` is duck-typed to just what's needed, so this stays client-agnostic.
export const requireKey =
  (web: { configured: boolean }) =>
  (fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> => {
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

// A SteamID64 for an individual profile is always exactly 17 digits and never
// below the individual-account base (76561197960265728 = accountid 0); a bare
// \d{17} would also accept syntactic garbage like all-zeros, so the lower bound
// is enforced too. .trim() first so a copy-pasted id with stray whitespace is
// accepted, matching the vanity field and the STEAM_ID env var (commit e86eb29).
// BigInt keeps the comparison exact (the value exceeds Number.MAX_SAFE_INTEGER);
// the refine is runtime-only and drops out of the generated JSON Schema, so it
// never trips z.toJSONSchema()'s unrepresentable guard (see AGENTS.md).
const STEAMID64_MIN = 76561197960265728n;
const STEAMID64_MSG =
  "A SteamID64 is a 17-digit number starting at 76561197960265728. " +
  "Use resolve_vanity_url to convert a custom profile name.";
const steamId64Base = z
  .string()
  .trim()
  .regex(/^\d{17}$/, STEAMID64_MSG)
  .refine((s) => BigInt(s) >= STEAMID64_MIN, STEAMID64_MSG);

export const steamid = steamId64Base
  .describe(
    "17-digit SteamID64. Omit to use the STEAM_ID configured on the server. " +
      "Convert a vanity/custom URL name with resolve_vanity_url first.",
  )
  .optional();

// compare_players's second, required id — same validation as `steamid`, built
// from the same base so the regex/range/message can't drift out of sync
// (AGENTS.md: one shared steamid schema, not redeclared per tool).
export const otherSteamid = steamId64Base.describe(
  "The other player's 17-digit SteamID64 to compare against. " +
    "Convert a vanity/custom profile name with resolve_vanity_url first.",
);

// Collapses the "resolve steamid (arg or STEAM_ID default), call one client
// method" shape shared by every steamid tool — wrapped via requireKey above
// (webPlayer.ts's tools), or keyless via reply (webStore.ts's get_followed_games).
// Generic over the tool's full input type so tools that take extra params
// besides steamid (get_owned_games's check_appids, compare_players's
// other_steamid, ...) still go through this instead of each hand-rolling
// `await web.requireSteamId(id)` themselves. `web` is duck-typed to just
// what's needed, so this stays client-agnostic.
export const steamIdTool =
  <TIn extends { steamid?: string }>(
    web: { requireSteamId: (explicit?: string) => Promise<string> },
    wrap: (fn: () => Promise<Record<string, unknown>>) => Promise<ToolResult>,
    fn: (sid: string, input: TIn) => Promise<Record<string, unknown>>,
  ) =>
  (input: TIn) =>
    wrap(async () => fn(await web.requireSteamId(input.steamid), input));
