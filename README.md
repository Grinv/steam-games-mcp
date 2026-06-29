# steam-mcp

[![npm version](https://img.shields.io/npm/v/steam-mcp.svg)](https://www.npmjs.com/package/steam-mcp)
[![CI](https://github.com/Grinv/steam-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Grinv/steam-mcp/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/steam-mcp.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server for **Steam**: search games and
read store details, prices, reviews, discounts and news (no key), plus player
profiles, libraries and achievements via the official **Steam Web API** (free key).

Works with any MCP client (Claude Desktop/Code, Cursor, VS Code, Cline, …) over stdio.

## Install

Add it to your MCP client's config. Store/search tools work with **no
credentials**; player tools need a free Steam Web API key.

```json
{
  "mcpServers": {
    "steam": {
      "command": "npx",
      "args": ["-y", "steam-mcp"],
      "env": {
        "STEAM_API_KEY": "your-steam-web-api-key (optional — enables player tools)",
        "STEAM_COUNTRY": "US (optional — store price region)",
        "STEAM_LANGUAGE": "english (optional — store language)"
      }
    }
  }
}
```

> Replace each value with your own; remove the optional lines you don't need.
> A free key comes from <https://steamcommunity.com/dev/apikey>. **From source:**
> `npm ci && npm run build`, then use `"command": "node"`,
> `"args": ["/ABS/PATH/steam-mcp/dist/index.js"]`. **As a `.mcpb` bundle:** grab it
> from the [latest release](https://github.com/Grinv/steam-mcp/releases/latest).

## What it does

Key: **–** no credentials · **K** Steam Web API key · **I** IsThereAnyDeal key.

| Tool                      | Key | Purpose                                                                            |
| ------------------------- | --- | ---------------------------------------------------------------------------------- |
| `search_games`            | –   | Find games by title → appid (with price)                                           |
| `get_game`                | –   | Store details: price, genres, platforms, Metacritic, age rating, DLC, requirements |
| `get_game_reviews`        | –   | Review summary + recent reviews                                                    |
| `get_review_histogram`    | –   | Review trend over time (history + recent)                                          |
| `get_prices`              | –   | Batch current price/discount for many appids                                       |
| `get_specials`            | –   | Steam front-page discounts                                                         |
| `get_featured`            | –   | Featured sections (top sellers, new releases, …)                                   |
| `get_game_news`           | –   | Recent news / patch notes                                                          |
| `get_global_achievements` | –   | Global achievement unlock rates (rarity)                                           |
| `get_current_players`     | –   | Live concurrent player count                                                       |
| `get_wishlist`            | –   | A player's wishlist appids (public profiles)                                       |
| `get_game_achievements`   | K   | Full achievement list (names, descriptions) + rarity                               |
| `resolve_vanity_url`      | K   | Custom profile name → SteamID64                                                    |
| `get_player_summary`      | K   | Player public profile                                                              |
| `get_owned_games`         | K   | A player's games + playtime                                                        |
| `get_recently_played`     | K   | Games played in the last two weeks                                                 |
| `get_player_achievements` | K   | A player's achievement progress in a game                                          |
| `get_deals`               | I   | Catalog-wide current discounts (filter by `min_cut`)                               |
| `get_price_history`       | I   | A game's price history + all-time low                                              |

**Three tiers.** Storefront + keyless Web API tools (`store`/`api.steampowered.com`)
need **no credentials**. Player tools need a free **`STEAM_API_KEY`** and a
**public** profile. `get_deals` / `get_price_history` need a free
**`ITAD_API_KEY`** ([IsThereAnyDeal](https://isthereanydeal.com/apps/)) — the
catalog-wide discount/price-history features Steam's own APIs don't expose. Tools
that need a key return a clear message when it is unset.

> SteamDB is not used (no public API + scraping is disallowed). This product is
> not affiliated with Valve, Steam or IsThereAnyDeal.

## Develop

```sh
npm install
npm run build        # type-check + bundle to dist/index.js
npm test             # node:test (mocked, offline)
npm run lint
npm run format
npm run check:api    # live upstream health-check (Storefront keyless; player check needs STEAM_API_KEY)
npm run inspector    # run under the MCP Inspector
```

Runtime requires Node ≥ 18. Contributor/agent guidance: [AGENTS.md](AGENTS.md).
Per-client config and all tunables: [docs/clients.md](docs/clients.md).

## Updating

- **npx:** unpinned `npx -y steam-mcp` fetches the latest on the next run.
- **`.mcpb` bundle:** download the new bundle from the releases page and reinstall.
- **From source:** `git pull && npm ci && npm run build`.

## License

[MIT](LICENSE) © Grinv
