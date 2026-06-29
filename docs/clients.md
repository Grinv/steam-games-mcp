# Client configuration

This is a standard stdio MCP server. Store/search tools need no credentials;
player tools need a free Steam Web API key (<https://steamcommunity.com/dev/apikey>).

Run via `npx -y steam-mcp` (once installed from npm) or from a built clone with
`node /ABS/PATH/steam-mcp/dist/index.js` after `npm ci && npm run build`.

## Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "steam": {
      "command": "npx",
      "args": ["-y", "steam-mcp"],
      "env": {
        "STEAM_API_KEY": "your-steam-web-api-key",
        "STEAM_COUNTRY": "US",
        "STEAM_LANGUAGE": "english"
      }
    }
  }
}
```

`STEAM_API_KEY` is optional (omit it and the store/search tools still work).

## Cursor / VS Code / Cline / others

Use the same stdio pattern:

- command: `npx` (or `node` for a local build)
- args: `["-y", "steam-mcp"]` (or `["/ABS/PATH/steam-mcp/dist/index.js"]`)
- env: `STEAM_API_KEY` (optional), `STEAM_COUNTRY`, `STEAM_LANGUAGE`.

## Tunables (optional env)

| Var                           | Default                          | Meaning                                                            |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `STEAM_API_KEY`               | _(unset)_                        | Steam Web API key; enables player tools                            |
| `ITAD_API_KEY`                | _(unset)_                        | IsThereAnyDeal key; enables get_deals / get_price_history          |
| `STEAM_COUNTRY`               | `US`                             | ISO country code (cc) for store prices                             |
| `STEAM_LANGUAGE`              | `english`                        | Store language (l)                                                 |
| `ITAD_BASE_URL`               | `https://api.isthereanydeal.com` | IsThereAnyDeal API base URL                                        |
| `STEAM_STORE_MIN_INTERVAL_MS` | `250`                            | Min spacing between Storefront calls (burst-sensitive; 0 disables) |
| `STEAM_API_MIN_INTERVAL_MS`   | `0`                              | Min spacing between Web API calls                                  |
| `CACHE_TTL_MS`                | `300000`                         | TTL for cached responses                                           |
| `HTTP_TIMEOUT_MS`             | `15000`                          | Per-request timeout                                                |
| `HTTP_RETRIES`                | `2`                              | Retries for transient failures                                     |
| `LOG_LEVEL`                   | `info`                           | `debug` \| `info` \| `warn` \| `error` \| `silent`                 |
| `STEAM_API_BASE_URL`          | `https://api.steampowered.com`   | Web API base URL                                                   |
| `STEAM_STORE_BASE_URL`        | `https://store.steampowered.com` | Storefront base URL                                                |
