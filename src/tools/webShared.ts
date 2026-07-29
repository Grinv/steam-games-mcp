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

export const steamid = z
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
