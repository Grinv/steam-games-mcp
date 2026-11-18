// Shared building blocks for the two Steam Web API tool registrations
// (webStore.ts: keyless-capable; webPlayer.ts: key-required) — split out of a
// single tools/web.ts once it grew past ~550 lines. Kept separate from
// tools/common.ts, which stays domain-agnostic (shared with tools/storefront.ts
// too) — `steamid` and the steamid-resolving helper below are Web-API-specific.
import { z } from "zod";
import { ownProblem, type Problem } from "../lib/result.ts";
import { isSteamId64, STEAMID64_RANGE, STEAMID64_RE } from "../format/shared.ts";

// Appended to the key-gate message, but only for the tools that ALSO need the
// target profile's privacy opened up. Four key-gated tools don't:
// get_player_summary and get_player_bans read private profiles fine (which is
// exactly why their found:false says "no such account" rather than offering a
// privacy hint), resolve_vanity_url resolves a name rather than reading a
// profile, and get_game_achievements takes an appid and no profile at all.
// Telling those four to go make a profile public sends the caller after a
// setting that would change nothing about the error they just got.
export const PUBLIC_PROFILE_NOTE =
  " (Note: the target profile must also be public — this tool's description says which " +
  "privacy setting.)";

// Gates every key-required player tool on STEAM_API_KEY being set; one clear
// message instead of a round-trip 403. Lives here (not as a private closure
// inside webPlayer.ts) so "what happens when the key is missing" is
// discoverable next to this file's other Web-API-specific building blocks —
// `web` is duck-typed to just what's needed, so this stays client-agnostic.
// A `gate` for tool() (tools/guard.ts): it answers before the handler runs.
export const keyGate =
  (web: { configured: boolean }, note = "") =>
  (): Problem | undefined =>
    web.configured
      ? undefined
      : ownProblem(
          "not_configured",
          "This tool needs a Steam Web API key. Set STEAM_API_KEY to a free key from " +
            "https://steamcommunity.com/dev/apikey." +
            note,
        );

// A SteamID64 for an individual profile is always exactly 17 digits: the
// individual-account base (76561197960265728) plus a 32-bit account number
// from 1 — so 76561197960265729 to 76561202255233023. Anything else names no
// account by construction (accountid 0 is Steam's own 400), so it is refused
// here rather than sent and read back as an answer. .trim() first so a copy-pasted id with stray whitespace is
// accepted, matching the vanity field and the STEAM_ID env var (commit e86eb29).
// The refine is runtime-only and drops out of the generated JSON Schema, so it
// never trips z.toJSONSchema()'s unrepresentable guard (see AGENTS.md).
const STEAMID64_MSG = STEAMID64_RANGE + " Use resolve_vanity_url to convert a custom profile name.";
// Exported so tools/prompts.ts can reuse the same validation for its own
// steamid argument under a prompt-specific .describe() — AGENTS.md's "one shared
// steamid schema" rule covers every surface that takes one, prompts included.
export const steamId64Base = z
  .string()
  .trim()
  .regex(STEAMID64_RE, STEAMID64_MSG)
  // zod runs .refine() even when .regex() above already failed: defer to the
  // regex issue for a value that isn't 17 digits, so its message wins.
  .refine((s) => !STEAMID64_RE.test(s) || isSteamId64(s), STEAMID64_MSG);

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
// method" shape shared by every steamid tool into a tool() handler — gated
// on the key (webPlayer.ts's tools) or not (webStore.ts's get_wishlist and
// get_followed_games, neither of which needs the key for a raw SteamID64).
// Generic over the tool's full input type so tools that take extra params
// besides steamid (get_owned_games's check_appids, compare_players's
// other_steamid, ...) still go through this instead of each hand-rolling
// `await web.requireSteamId(id)` themselves. `web` is duck-typed to just
// what's needed, so this stays client-agnostic.
export const steamIdTool =
  <TIn extends { steamid?: string }>(
    web: { requireSteamId: (explicit?: string) => Promise<string> },
    fn: (sid: string, input: TIn) => Promise<Record<string, unknown>>,
  ) =>
  async (input: TIn) =>
    fn(await web.requireSteamId(input.steamid), input);
