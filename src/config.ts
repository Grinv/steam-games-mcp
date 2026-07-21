// Loads and validates configuration from environment variables. Two upstreams:
// the Steam Storefront API (game/store data — no key) and the official Steam
// Web API (player profiles, library, achievements — needs a free key from
// https://steamcommunity.com/dev/apikey). The key is optional so the server
// always starts and the store + keyless tools work; player tools report a clear
// error at call time when it is missing. Empty strings AND unsubstituted .mcpb
// placeholders (e.g. "${user_config.steam_id}") are treated as unset.
import { z } from "zod";
import type { LogLevel } from "./lib/logger.js";

const EnvSchema = z.object({
  // --- Steam Web API: free key (player data). https://steamcommunity.com/dev/apikey
  STEAM_API_KEY: z.string().min(1).optional(),
  STEAM_API_BASE_URL: z.string().url().default("https://api.steampowered.com"),
  // Default player for the personal tools (wishlist/library/achievements) so a
  // SteamID64 need not be passed every call. Accepts a 17-digit SteamID64 or a
  // vanity name (the part after /id/), resolved once via the Web API (needs a key).
  STEAM_ID: z.string().min(2).optional(),
  // --- Steam Storefront API: no key; game/store data. ---
  STEAM_STORE_BASE_URL: z.string().url().default("https://store.steampowered.com"),

  // Storefront is region/locale-aware: cc = ISO country (prices), l = language.
  STEAM_COUNTRY: z.string().min(2).max(2).default("US"),
  STEAM_LANGUAGE: z.string().min(2).default("english"),

  // --- Generic tunables. ---
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  HTTP_RETRIES: z.coerce.number().int().nonnegative().default(2),
  // The Storefront API is unofficial and rate-sensitive to bursts, so space its
  // calls; the Web API allows ~100k/day and needs little throttling. 0 disables.
  STEAM_STORE_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(250),
  STEAM_API_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(0),
  CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(300_000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export interface Config {
  steamApiBaseUrl: string;
  steamApiKey: string | undefined;
  defaultSteamId: string | undefined;
  steamStoreBaseUrl: string;
  country: string;
  language: string;
  httpTimeoutMs: number;
  httpRetries: number;
  storeMinIntervalMs: number;
  apiMinIntervalMs: number;
  cacheTtlMs: number;
  logLevel: LogLevel;
}

// .mcpb leaves an UNFILLED optional user_config field as the literal,
// unsubstituted placeholder (e.g. "${user_config.steam_id}") rather than "".
// Such a value is non-empty, so without this it would be taken as a real key /
// SteamID — making web.configured true and sending garbage to Steam (→ 403).
const UNSUBSTITUTED_PLACEHOLDER = /^\$\{[^}]*\}$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Drop empty/whitespace-only strings and unsubstituted ${...} placeholders so
  // defaults apply and optional fields (key, STEAM_ID) stay genuinely unset.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(
      ([, v]) => v !== undefined && v.trim() !== "" && !UNSUBSTITUTED_PLACEHOLDER.test(v),
    ),
  );
  const parsed = EnvSchema.parse(cleaned);

  return {
    steamApiBaseUrl: parsed.STEAM_API_BASE_URL,
    steamApiKey: parsed.STEAM_API_KEY,
    defaultSteamId: parsed.STEAM_ID,
    steamStoreBaseUrl: parsed.STEAM_STORE_BASE_URL,
    country: parsed.STEAM_COUNTRY,
    language: parsed.STEAM_LANGUAGE,
    httpTimeoutMs: parsed.HTTP_TIMEOUT_MS,
    httpRetries: parsed.HTTP_RETRIES,
    storeMinIntervalMs: parsed.STEAM_STORE_MIN_INTERVAL_MS,
    apiMinIntervalMs: parsed.STEAM_API_MIN_INTERVAL_MS,
    cacheTtlMs: parsed.CACHE_TTL_MS,
    logLevel: parsed.LOG_LEVEL,
  };
}
