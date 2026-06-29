// Server construction and stdio startup. Kept separate from the bin entry
// (index.ts) so tests can import buildServer without triggering startup.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { StorefrontClient } from "./clients/storefront.js";
import { SteamWebClient } from "./clients/web.js";
import { ItadClient } from "./clients/itad.js";
import { registerStorefrontTools } from "./tools/storefront.js";
import { registerWebTools } from "./tools/web.js";
import { registerItadTools } from "./tools/itad.js";
import { VERSION } from "./version.js";

const INSTRUCTIONS =
  "Query Steam games and players. Store data needs no key: search_games → get_game / " +
  "get_game_reviews for details, get_specials / get_featured for what's on sale, get_game_news and " +
  "get_global_achievements for a game's news and achievement rarity. Player data needs a free " +
  "Steam Web API key (STEAM_API_KEY): get_player_summary, get_owned_games, get_recently_played and " +
  "get_player_achievements take a 17-digit SteamID64 — use resolve_vanity_url to convert a custom " +
  "profile name first, and note the target profile must be public. For catalog-wide discounts and " +
  "price history (e.g. 'all games >80% off', 'is this a historic low'), use get_deals and " +
  "get_price_history (need a free IsThereAnyDeal key, ITAD_API_KEY). Tools that need a key report " +
  "clearly when it is unset.";

/** Construct a fully-registered MCP server. Shared by start() and tests. */
export function buildServer(config: Config, logger: Logger): McpServer {
  const store = new StorefrontClient(config, logger);
  const web = new SteamWebClient(config, logger);
  const itad = new ItadClient(config, logger);

  const server = new McpServer(
    { name: "steam-mcp", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerStorefrontTools(server, store);
  registerWebTools(server, web);
  registerItadTools(server, itad);
  return server;
}

/** Load config, build the server, and serve over stdio until terminated. */
export async function start(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const server = buildServer(config, logger);

  await server.connect(new StdioServerTransport());
  logger.info(`steam-mcp ${VERSION} ready`);

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
