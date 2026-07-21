# Steam MCP Server

[![npm version](https://img.shields.io/npm/v/steam-games-mcp.svg)](https://www.npmjs.com/package/steam-games-mcp)
[![CI](https://github.com/Grinv/steam-games-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Grinv/steam-games-mcp/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/steam-games-mcp.svg)](LICENSE)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.Grinv%2Fsteam--games--mcp-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Grinv/steam-games-mcp&version=latest)
[![steam-games-mcp MCP server](https://glama.ai/mcp/servers/Grinv/steam-games-mcp/badges/score.svg)](https://glama.ai/mcp/servers/Grinv/steam-games-mcp)

An [MCP](https://modelcontextprotocol.io) server for **Steam**: search games and
read store details, prices, reviews, discounts and news (no key), plus player
profiles, libraries and achievements via the official **Steam Web API** (free key).

**Read-only · official Steam APIs only · most tools need no key · open source.**
Nobody logs in; the only credential is a free Steam Web API key you set yourself,
and the server never writes, trades, posts, launches games, or makes purchases.

Works with any MCP client (Claude Desktop/Code, Cursor, VS Code, Cline, …) over stdio.

Once it's connected, just ask your agent in natural language.

**No credentials needed** (store, search & discovery):

```
"Find Hollow Knight and tell me its price, genres and age rating."
"What are recent reviews saying about Baldur's Gate 3?"
"Have Cyberpunk 2077's reviews recovered since launch?"
"Which games are >80% off right now with 90%+ positive reviews?"
"Find roguelike deckbuilders on sale."
"What discounted games run natively on macOS?"
"Which recent, well-reviewed games run on Steam Deck?"
"What well-reviewed games run on SteamOS?"
"Any games verified for the Steam Machine on sale?"
"Any Steam Frame–Verified VR games on sale?"
"What's discounted on Steam's front page right now?"
"Show me Steam's top sellers and newest releases."
"Any recent patch notes for No Man's Sky?"
"How rare is each achievement in Elden Ring?"
"How many people are playing Counter-Strike 2 right now?"
"Get current prices for appids 620, 413150 and 1145360."
"For appids 1245620 and 1086940, show price, review % and Deck / SteamOS / Machine / Frame status."
```

**With a free API key + your `STEAM_ID`** (your account; see [Getting your credentials](#getting-your-credentials)):

```
"Show my Steam profile."
"List my games by playtime."
"What have I played in the last two weeks?"
"Recommend something I'd like based on my library, on a good discount."
"Do I already own Hollow Knight and Hades?"
"What's on my wishlist that's discounted and well-reviewed?"
"List Hollow Knight's achievements and how rare each one is."
"How far am I through Elden Ring's achievements?"
"What's the SteamID64 for the profile name 'gabelogannewell'?"
"Which of my friends own Portal 2, and how many hours have they played?"
"What games do my friend and I both own, and who's played them more?"
"Show me my Steam friends list."
"Is SteamID 76561197960287930 VAC banned?"
"What games am I following that aren't on my wishlist?"
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
> `"args": ["/ABS/PATH/steam-games-mcp/dist/index.js"]`.

### One-click install (Claude Desktop)

Download [**`steam-games-mcp.mcpb`**](https://github.com/Grinv/steam-games-mcp/releases/latest/download/steam-games-mcp.mcpb)
(always the latest release) and open it in Claude Desktop — **Settings → Extensions** — then
fill the optional fields (API key, Steam ID, country, language) in the install form. No JSON editing.

Also listed in the [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Grinv/steam-games-mcp&version=latest)
as `io.github.Grinv/steam-games-mcp`.

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

## Tools

Key: **–** no credentials · **K** Steam Web API key.

| Tool                      | Key | Purpose                                                                                                              |
| ------------------------- | --- | -------------------------------------------------------------------------------------------------------------------- |
| `search_games`            | –   | Find games by title → appid (with price)                                                                             |
| `get_game`                | –   | Store details by appid **or name**: price, genres, platforms, Metacritic, age rating, DLC, requirements              |
| `get_items`               | –   | Batch store card (price, review %, **Deck/SteamOS/Machine/Frame** compat, native **platforms**, **tags**) for appids |
| `discover_games`          | –   | Find games catalog-wide by **discount**, **recency**, **Deck/SteamOS/Machine/Frame**, **platform**, **tags**, rating |
| `get_game_reviews`        | –   | Review summary + recent reviews                                                                                      |
| `get_review_histogram`    | –   | Review trend over time (history + recent)                                                                            |
| `get_prices`              | –   | Batch current price/discount for many appids                                                                         |
| `get_specials`            | –   | Steam front-page discounts                                                                                           |
| `get_featured`            | –   | Featured sections (top sellers, new releases, …)                                                                     |
| `get_game_news`           | –   | Recent news / patch notes                                                                                            |
| `get_global_achievements` | –   | Global achievement unlock rates (rarity)                                                                             |
| `get_current_players`     | –   | Live concurrent player count                                                                                         |
| `get_wishlist`            | –   | A player's wishlist — appids, or full cards + on-sale filter with `include_details` (public profiles)                |
| `get_followed_games`      | –   | A player's followed games (Steam's "follow" feature, separate from the wishlist) — appids (public profiles)          |
| `get_game_achievements`   | K   | Full achievement list (names, descriptions) + rarity                                                                 |
| `resolve_vanity_url`      | K   | Custom profile name → SteamID64                                                                                      |
| `get_player_summary`      | K   | Player public profile (incl. Steam level)                                                                            |
| `get_player_bans`         | K   | VAC/game/community/economy ban status (works even on private profiles)                                               |
| `get_owned_games`         | K   | A player's games + playtime (top 50 by playtime; `check_appids` reliably checks specific appids past that cap)       |
| `get_recently_played`     | K   | Games played in the last two weeks                                                                                   |
| `get_recommended_games`   | K   | Personalized picks from playtime-weighted tags + review quality, excluding owned games                               |
| `get_player_achievements` | K   | A player's achievement progress in a game                                                                            |
| `get_friend_list`         | K   | A player's friends — name, online state, current game (public friends list)                                          |
| `find_friends_who_own`    | K   | Which friends own given appid(s) + their playtime — checks each friend's FULL library, not just top 50               |
| `compare_players`         | K   | Games two players both own, with each one's playtime — checks each player's FULL library, not just top 50            |

**Two tiers.** Store/search + discovery tools (`store`/`api.steampowered.com`)
need **no credentials** — including catalog-wide discovery (`discover_games`:
deals, new releases, Deck / SteamOS / Machine / Frame compatibility, tags, rating) and batch
price/review checks (`get_items`).
Player tools need a free
**`STEAM_API_KEY`** and a **public** profile; they return a clear message when the
key is unset. Set **`STEAM_ID`** (a SteamID64 or vanity name) to make those tools
default to you, so "my wishlist / library" works without passing an ID each time.

> No third-party services: deal discovery and reviews come from Steam's own
> (keyless) store APIs. SteamDB is not used (no public API + scraping disallowed).
> Steam has no price-history API, so that isn't offered. Not affiliated with Valve.

## Prompts

Guided one-shot prompts that orchestrate several tools for a common question —
use these when your client exposes MCP prompts, instead of describing the steps yourself:

| Prompt               | Args                                                               | What it does                                                               |
| -------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `what_should_i_play` | `steamid`, `budget`, `tags` (all optional)                         | Recommends catalog games from your library/taste, excluding what you own   |
| `is_it_worth_buying` | `game` (title or appid, optional — autocompletes; asks if omitted) | Price, review trend and Steam Deck compatibility → a buy/wait/skip verdict |
| `deals_digest`       | `min_discount`, `min_review`, `tags` (all optional)                | A curated list of well-reviewed discounted games                           |

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

Runtime requires Node ≥ 20. Contributor/agent guidance: [AGENTS.md](AGENTS.md).
Security policy: [SECURITY.md](SECURITY.md).
Per-client config and all tunables: [docs/clients.md](docs/clients.md).

## Updating

- **npx:** unpinned `npx -y steam-games-mcp` fetches the latest on the next run.
- **`.mcpb` bundle:** download the new bundle from the releases page and reinstall.
- **From source:** `git pull && npm ci && npm run build`.

## License

[MIT](LICENSE) © Grinv
