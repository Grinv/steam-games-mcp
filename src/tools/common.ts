// Shared tool building blocks used by both the storefront and Web API tool
// registrations: common annotations, reusable zod parameter schemas (written for
// the calling model), and the reply() wrapper that turns a formatter result into
// a guarded ToolResult. Kept here so the two registration files stay DRY.
import { z } from "zod";
import { jsonResult, type ToolResult } from "../lib/result.js";
import type { CompatFilters } from "../format/store.js";
import { guard } from "./guard.js";

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export const appid = z
  .number()
  .int()
  .positive()
  .describe("Steam application id (appid). Get it from search_games.");

// Per-call overrides of the server defaults (STEAM_COUNTRY / STEAM_LANGUAGE).
export const country = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "Two-letter ISO country code, e.g. US, RU, DE.")
  .describe("Country (cc) for prices/currency; overrides STEAM_COUNTRY for this call.")
  .optional();
export const language = z
  .string()
  .trim()
  .min(2)
  .describe("Store language (e.g. english, russian); overrides STEAM_LANGUAGE for this call.")
  .optional();

// Native-platform filter shared by discover_games and get_wishlist: keeps only
// games with a NATIVE build for that OS. "linux" means a native Linux/SteamOS
// build — distinct from steam_os (SteamOS-via-Proton compatibility).
export const platform = z
  .enum(["windows", "mac", "linux"])
  .describe(
    "NATIVE-build filter: keep only games shipping a native build for this OS (windows/mac/linux). " +
      "'linux' = a native Linux/SteamOS port. This is NOT Proton — for games that run via Proton " +
      "compatibility use steam_os / steam_deck instead. Each result's `platforms` field lists its " +
      "native builds, while steam_os/steam_deck report Proton compatibility, so native vs Proton stay distinct.",
  )
  .optional();

// Compat (Proton) filters shared by discover_games and get_wishlist. These are
// Valve's compatibility RATINGS (Proton/verification), distinct from `platform`
// (a native build). 'verified' = that rating only; 'playable' = Playable or Verified.
export const steamDeck = z
  .enum(["playable", "verified"])
  .describe(
    "Steam Deck compatibility (runs via Proton): 'verified' = Deck-Verified only; " +
      "'playable' = Playable or Verified. Not a native Linux build — see `platform` for that.",
  )
  .optional();
export const steamOs = z
  .enum(["playable", "verified"])
  .describe(
    "SteamOS compatibility — how well it runs on SteamOS in general (via Proton): 'verified' = " +
      "SteamOS-Verified only; 'playable' = Playable or Verified. For a NATIVE Linux build instead, " +
      "use platform:'linux'; for the Steam Machine console specifically, use steam_machine.",
  )
  .optional();
export const steamMachine = z
  .enum(["playable", "verified"])
  .describe(
    "Steam Machine (Valve's console) compatibility (via Proton): 'verified' = Steam-Machine-Verified " +
      "only; 'playable' = Playable or Verified. Its own rating, distinct from the general steam_os one.",
  )
  .optional();
export const steamFrame = z
  .enum(["playable", "verified"])
  .describe(
    "Steam Frame (VR headset) compatibility: 'verified' = Frame-Verified only; " +
      "'playable' = Playable or Verified.",
  )
  .optional();

// Renames the 5 hardware-compat tool args above from their snake_case
// tool-facing names to the camelCase shape clients/storeService.ts's
// discoverGames/getWishlistDetailed expect — shared by discover_games and
// get_wishlist (tools/webStore.ts) so a 6th compat dimension only needs
// renaming in one place instead of two.
export function toCompatFilters(input: {
  platform?: z.infer<typeof platform>;
  steam_deck?: z.infer<typeof steamDeck>;
  steam_os?: z.infer<typeof steamOs>;
  steam_machine?: z.infer<typeof steamMachine>;
  steam_frame?: z.infer<typeof steamFrame>;
}): CompatFilters & { platform?: z.infer<typeof platform> } {
  return {
    platform: input.platform,
    steamDeck: input.steam_deck,
    steamOs: input.steam_os,
    steamMachine: input.steam_machine,
    steamFrame: input.steam_frame,
  };
}

// Run a formatter and wrap its result as a JSON ToolResult; guard() turns any
// thrown ApiError into an actionable { isError: true } result.
export const reply = (fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> =>
  guard(async () => jsonResult(await fn()));
