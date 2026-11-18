// What Steam's own inputs can be — a SteamID64, a language name — checked by
// config, tools and clients alike, so one definition serves all three
// (AGENTS.md: refuse an input Steam would misread). Not format/: nothing here
// shapes a response.
import { z } from "zod";

// The 17-digit SteamID64 shape: the steamid tool input (tools/webShared.ts)
// and the SteamID64-vs-vanity split of STEAM_ID (clients/web.ts).
export const STEAMID64_RE = /^\d{17}$/;

// A 17-digit string that can name an account: accountid (the low 32 bits) is
// 1..2^32-1. BigInt keeps the comparison exact past Number.MAX_SAFE_INTEGER.
export function isSteamId64(s: string): boolean {
  if (!STEAMID64_RE.test(s)) return false;
  const accountid = BigInt(s) - 76561197960265728n;
  return accountid >= 1n && accountid <= 0xffffffffn;
}

// What a steamid input accepts: a 17-digit value must name an account;
// anything else isn't a SteamID64 at all (the regex or a vanity says so).
export const steamIdAccepts = (s: string): boolean => !STEAMID64_RE.test(s) || isSteamId64(s);

// Steam's language names (its "API language code" column,
// partner.steamgames.com/doc/store/localization/languages). Steam answers any
// other value as if it were a language — English text, an empty tag
// dictionary, zero reviews — so only these reach it. Each verified live
// 2026-11-18: a full GetTagList dictionary, where "korean" and "ru" get none.
export const STEAM_LANGUAGES = [
  "arabic",
  "bulgarian",
  "schinese",
  "tchinese",
  "czech",
  "danish",
  "dutch",
  "english",
  "finnish",
  "french",
  "german",
  "greek",
  "hungarian",
  "indonesian",
  "italian",
  "japanese",
  "koreana",
  "malay",
  "norwegian",
  "polish",
  "portuguese",
  "brazilian",
  "romanian",
  "russian",
  "spanish",
  "latam",
  "swedish",
  "thai",
  "turkish",
  "ukrainian",
  "vietnamese",
] as const;
export const STEAMID64_RANGE =
  "A SteamID64 is a 17-digit number from 76561197960265729 to 76561202255233023.";

/** A Steam language name in any case or padding (Steam ignores case), plus
 *  `also` (e.g. review_language's "all"). The JSON Schema lists the names, so
 *  the model sees them; .meta, not z.enum, since an enum can't lowercase. */
export function steamLanguage(...also: string[]) {
  const names = [...also, ...STEAM_LANGUAGES];
  return z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => names.includes(v), `Expected one of Steam's names: ${names.join(", ")}.`)
    .meta({ enum: names });
}
