// Loads and validates configuration from environment variables. Two upstreams:
// the Steam Storefront API (game/store data — no key) and the official Steam
// Web API (player profiles, library, achievements — needs a free key from
// https://steamcommunity.com/dev/apikey). The key is optional so the server
// always starts and the store + keyless tools work; player tools report a clear
// error at call time when it is missing. Empty strings are treated as unset so
// .mcpb (which passes "" for unconfigured user_config fields) does not crash.
import { z } from "zod";
import type { LogLevel } from "./lib/logger.js";

const EnvSchema = z.object({
  // --- Steam Web API: free key (player data). https://steamcommunity.com/dev/apikey
  STEAM_API_KEY: z.string().min(1).optional(),
  STEAM_API_BASE_URL: z.string().url().default("https://api.steampowered.com"),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Drop empty-string values so defaults apply and the optional key stays unset.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const parsed = EnvSchema.parse(cleaned);

  return {
    steamApiBaseUrl: parsed.STEAM_API_BASE_URL,
    steamApiKey: parsed.STEAM_API_KEY,
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
