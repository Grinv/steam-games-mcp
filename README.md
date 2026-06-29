# steam-games-mcp

[![npm version](https://img.shields.io/npm/v/steam-games-mcp.svg)](https://www.npmjs.com/package/steam-games-mcp)
[![CI](https://github.com/Grinv/steam-games-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Grinv/steam-games-mcp/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/steam-games-mcp.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server for **Steam**: search games and
read store details, prices, reviews, discounts and news (no key), plus player
profiles, libraries and achievements via the official **Steam Web API** (free key).

Works with any MCP client (Claude Desktop/Code, Cursor, VS Code, Cline, …) over stdio.

Once it's connected, just ask your agent in natural language.

**No credentials needed** (store, search & discovery):

```
"Find Hollow Knight and tell me its price, genres and age rating."
"What are recent reviews saying about Baldur's Gate 3?"
"Have Cyberpunk 2077's reviews recovered since launch?"
"Which games are >80% off right now with 90%+ positive reviews?"
"Which recent, well-reviewed games run on Steam Deck?"
"What's discounted on Steam's front page right now?"
"Show me Steam's top sellers and newest releases."
"Any recent patch notes for No Man's Sky?"
"How rare is each achievement in Elden Ring?"
"How many people are playing Counter-Strike 2 right now?"
"Get current prices for appids 620, 413150 and 1145360."
"For appids 1245620 and 1086940, show price, review % and Steam Deck status."
```

**With a free API key + your `STEAM_ID`** (your account; see [Getting your credentials](#getting-your-credentials)):

```
"Show my Steam profile."
"List my games by playtime."
"What have I played in the last two weeks?"
"What's on my wishlist that's discounted and well-reviewed?"
"List Hollow Knight's achievements and how rare each one is."
"How far am I through Elden Ring's achievements?"
"What's the SteamID64 for the profile name 'gabelogannewell'?"
```

## Install

Add it to your MCP client's config. Store/search tools work with **no
credentials**; player tools need a free Steam Web API key.

```json
{
  "mcpServers": {
    "steam": {
      "command": "npx",
      "args": ["-y", "steam-games-mcp"],
      "env": {
        "STEAM_API_KEY": "your-steam-web-api-key (optional — enables player tools)",
        "STEAM_ID": "your-steamid64-or-vanity-name (optional — default 'you' for player tools)",
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
> `"args": ["/ABS/PATH/steam-games-mcp/dist/index.js"]`. **As a `.mcpb` bundle:** grab it
> from the [latest release](https://github.com/Grinv/steam-games-mcp/releases/latest).

## Getting your credentials

Store, search and discovery tools need **nothing** — skip this section if that's
all you want. The **player** tools (profile, library, achievements, your wishlist)
need a free API key and a public profile. Three short steps:

1. **Get a free Steam Web API key.** Sign in at
   <https://steamcommunity.com/dev/apikey>, enter any domain (e.g. `localhost`),
   and copy the key into `STEAM_API_KEY`.
2. **Find your Steam ID.** Set `STEAM_ID` to either:
   - your **vanity name** — the custom part of your profile URL
     `steamcommunity.com/id/YOUR_NAME` → `YOUR_NAME` (resolved automatically), or
   - your **17-digit SteamID64** (`steamcommunity.com/profiles/7656…`; or look it
     up at <https://steamid.io>).

   With `STEAM_ID` set you can just ask "_my_ wishlist / library" — without it,
   give the agent a SteamID64 each time (use `resolve_vanity_url` to convert a name).

3. **Make your profile public** (for your own library/achievements): Steam →
   profile → **Edit Profile** → **Privacy Settings** → set **My profile** and
   **Game details** to **Public**.

> The key and Steam ID go in your MCP client config (the `env` block above) — see
> [docs/clients.md](docs/clients.md) for per-client examples. Never commit them.

## What it does

Key: **–** no credentials · **K** Steam Web API key.

| Tool                      | Key | Purpose                                                                                                 |
| ------------------------- | --- | ------------------------------------------------------------------------------------------------------- |
| `search_games`            | –   | Find games by title → appid (with price)                                                                |
| `get_game`                | –   | Store details by appid **or name**: price, genres, platforms, Metacritic, age rating, DLC, requirements |
| `get_items`               | –   | Batch store card (price, review %, **Steam Deck**, release) for a LIST of appids — one call             |
| `discover_games`          | –   | Find games catalog-wide by **discount**, **recency**, **Steam Deck** and rating — no appids needed      |
| `get_game_reviews`        | –   | Review summary + recent reviews                                                                         |
| `get_review_histogram`    | –   | Review trend over time (history + recent)                                                               |
| `get_prices`              | –   | Batch current price/discount for many appids                                                            |
| `get_specials`            | –   | Steam front-page discounts                                                                              |
| `get_featured`            | –   | Featured sections (top sellers, new releases, …)                                                        |
| `get_game_news`           | –   | Recent news / patch notes                                                                               |
| `get_global_achievements` | –   | Global achievement unlock rates (rarity)                                                                |
| `get_current_players`     | –   | Live concurrent player count                                                                            |
| `get_wishlist`            | –   | A player's wishlist appids (public profiles)                                                            |
| `get_game_achievements`   | K   | Full achievement list (names, descriptions) + rarity                                                    |
| `resolve_vanity_url`      | K   | Custom profile name → SteamID64                                                                         |
| `get_player_summary`      | K   | Player public profile                                                                                   |
| `get_owned_games`         | K   | A player's games + playtime                                                                             |
| `get_recently_played`     | K   | Games played in the last two weeks                                                                      |
| `get_player_achievements` | K   | A player's achievement progress in a game                                                               |

**Two tiers.** Store/search + discovery tools (`store`/`api.steampowered.com`)
need **no credentials** — including catalog-wide discovery (`discover_games`:
deals, new releases, Steam Deck, rating) and batch price/review checks (`get_items`).
Player tools need a free
**`STEAM_API_KEY`** and a **public** profile; they return a clear message when the
key is unset. Set **`STEAM_ID`** (a SteamID64 or vanity name) to make those tools
default to you, so "my wishlist / library" works without passing an ID each time.

> No third-party services: deal discovery and reviews come from Steam's own
> (keyless) store APIs. SteamDB is not used (no public API + scraping disallowed).
> Steam has no price-history API, so that isn't offered. Not affiliated with Valve.

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

- **npx:** unpinned `npx -y steam-games-mcp` fetches the latest on the next run.
- **`.mcpb` bundle:** download the new bundle from the releases page and reinstall.
- **From source:** `git pull && npm ci && npm run build`.

## License

[MIT](LICENSE) © Grinv
