// Shared building blocks for the two Steam Web API tool registrations
// (webStore.ts: keyless-capable; webPlayer.ts: key-required) — split out of a
// single tools/web.ts once it grew past ~550 lines. Kept separate from
// tools/common.ts, which stays domain-agnostic (shared with tools/storefront.ts
// too) — `steamid` and the steamid-resolving helper below are Web-API-specific.
import { z } from "zod";
import type { ToolResult } from "../lib/result.js";

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
// method" shape shared by every steamid tool — keyed via requireKey
// (webPlayer.ts), or keyless via reply (webStore.ts's get_followed_games).
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
