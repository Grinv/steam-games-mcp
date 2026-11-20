// Kept in sync with package.json by a unit test (see __tests__/version.test.ts).
export const VERSION = "0.18.0";

// The server's registry identity; kept equal to package.json mcpName by a test.
export const MCP_NAME = "io.github.Grinv/steam-games-mcp";

// Prefix for this server's own _meta keys. The MCP spec asks vendors for a
// reverse-DNS prefix (labels joined by dots, then "/"); the namespace half of
// MCP_NAME is exactly that, shared with sibling servers (io.github.Grinv/).
// The server itself is told apart by the SDK's io.modelcontextprotocol/serverInfo.
export const META_PREFIX = `${MCP_NAME.split("/")[0]}/`;

export const USER_AGENT = `steam-games-mcp/${VERSION} (+https://github.com/Grinv/steam-games-mcp)`;
