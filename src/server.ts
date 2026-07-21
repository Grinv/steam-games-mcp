import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";

// Server construction and stdio startup. Kept separate from the bin entry
// (index.ts) so tests can import buildServer without triggering startup.
import { loadConfig, type Config } from "./config.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { StorefrontClient } from "./clients/storefront.js";
import { SteamWebClient } from "./clients/web.js";
import { registerStorefrontTools } from "./tools/storefront.js";
import { registerStoreWebTools } from "./tools/webStore.js";
import { registerPlayerWebTools } from "./tools/webPlayer.js";
import { registerPrompts } from "./tools/prompts.js";
import { VERSION } from "./version.js";

const INSTRUCTIONS =
  "Query Steam games and players. Store data needs no key: search_games → get_game / " +
  "get_game_reviews for details, get_specials / get_featured for curated store sections, " +
  "discover_games to find titles catalog-wide by discount / recency / Steam Deck / review quality " +
  "(e.g. deals, new releases, Deck-Verified games), get_items to " +
  "price- and rating-check a list of appids in one call, get_game_news and get_global_achievements " +
  "for a game's news and achievement rarity, get_current_players for live player counts. Player " +
  "data needs a free Steam Web API key (STEAM_API_KEY): get_player_summary, get_owned_games, " +
  "get_recently_played and get_player_achievements take a 17-digit SteamID64 — use resolve_vanity_url " +
  "to convert a custom profile name first, and note the target profile must be public. For " +
  "personalized picks based on a player's own library (not manual filters), use get_recommended_games. " +
  "Tools that need the key report clearly when it is unset.";

/** Construct a fully-registered MCP server. Shared by start() and tests. */
export function buildServer(config: Config, logger: Logger): McpServer {
  const store = new StorefrontClient(config, logger);
  const web = new SteamWebClient(config, logger);

  const server = new McpServer(
    { name: "steam-games-mcp", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerStorefrontTools(server, store);
  registerStoreWebTools(server, web, web.store);
  registerPlayerWebTools(server, web);
  registerPrompts(server, store);
  return server;
}

/** Load config and serve over stdio until terminated. `serveStdio` owns the
 *  per-connection protocol-era negotiation (SEP-2577 / 2026-07-28): it may call
 *  the factory more than once while probing a connection's era, so the factory
 *  must stay side-effect-safe to call repeatedly (buildServer() always returns a
 *  fresh, independent instance).
 *
 *  Logging is stderr-only: no `logging` capability, no `notifications/message`
 *  push. Both are deprecated as of protocol 2026-07-28 (SEP-2577) in favor of
 *  stderr/OpenTelemetry for stdio servers — which is exactly what lib/logger.ts
 *  already does, so there's no client-push flow to carry forward. */
export async function start(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  // Arm signal/error handlers BEFORE calling serveStdio(): under CPU
  // contention the process can be descheduled between two synchronous
  // statements, and a SIGINT/SIGTERM arriving in that gap would hit Node's
  // default disposition (killed immediately, no graceful close) instead of
  // this handler if it were registered any later.
  const stdio: { handle?: ReturnType<typeof serveStdio> } = {};
  const shutdown = (signal: string): void => {
    logger.info(`received ${signal}, shutting down`);
    void (stdio.handle?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", reason));
  process.on("uncaughtException", (err) => {
    logger.error("uncaught exception", err);
    process.exit(1);
  });

  stdio.handle = serveStdio(() => buildServer(config, logger));
  logger.info(`steam-games-mcp ${VERSION} ready`);
}
