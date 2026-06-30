// Server construction and stdio startup. Kept separate from the bin entry
// (index.ts) so tests can import buildServer without triggering startup.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger, type Logger, type LogLevel, type LogSink } from "./lib/logger.js";
import { StorefrontClient } from "./clients/storefront.js";
import { SteamWebClient } from "./clients/web.js";
import { registerStorefrontTools } from "./tools/storefront.js";
import { registerWebTools } from "./tools/web.js";
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
  "to convert a custom profile name first, and note the target profile must be public. Tools that " +
  "need the key report clearly when it is unset.";

/** Construct a fully-registered MCP server. Shared by start() and tests. */
export function buildServer(config: Config, logger: Logger): McpServer {
  const store = new StorefrontClient(config, logger);
  const web = new SteamWebClient(config, logger);

  const server = new McpServer(
    { name: "steam-games-mcp", version: VERSION },
    // Declare the logging capability so the SDK registers `logging/setLevel`
    // and lets us push `notifications/message` to the client (see start()).
    { capabilities: { logging: {} }, instructions: INSTRUCTIONS },
  );

  registerStorefrontTools(server, store);
  registerWebTools(server, web);
  return server;
}

// Internal levels → MCP (syslog-style) levels for notifications/message.
const MCP_LOG_LEVELS = {
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
} as const satisfies Record<Exclude<LogLevel, "silent">, string>;

/** A {@link LogSink} that mirrors each log line onto the MCP client as a
 *  `notifications/message`. Best-effort: sends are dropped silently when there
 *  is no transport yet, when the client filtered the level via `logging/setLevel`,
 *  or after disconnect — logging must never break the server. */
export function mcpLoggingSink(server: McpServer): LogSink {
  return (level, message) => {
    void server.server
      .sendLoggingMessage({
        level: MCP_LOG_LEVELS[level],
        logger: "steam-games-mcp",
        data: message,
      })
      .catch(() => {});
  };
}

/** Load config, build the server, and serve over stdio until terminated. */
export async function start(): Promise<void> {
  const config = loadConfig();

  // Forward-ref via a holder: the logger is needed to build the server, but the
  // sink needs the server, so we fill it in once the server exists.
  const ref: { sink?: LogSink } = {};
  const logger = createLogger(config.logLevel, (level, message) => ref.sink?.(level, message));
  const server = buildServer(config, logger);
  ref.sink = mcpLoggingSink(server);

  await server.connect(new StdioServerTransport());
  logger.info(`steam-games-mcp ${VERSION} ready`);

  const shutdown = (signal: string): void => {
    logger.info(`received ${signal}, shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", reason));
  process.on("uncaughtException", (err) => {
    logger.error("uncaught exception", err);
    process.exit(1);
  });
}
