# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `discover_deals` — catalog-wide deal discovery via Steam's own keyless
  `IStoreQueryService/Query` (`price_filters.min_discount_percent`): find all
  games at/above a discount, with discount %, price, review % and release date in
  one call; optional `min_review` / `min_reviews` thresholds. No appids needed.
- `get_items` — batch store card (price/discount, review % positive, release
  date) for a LIST of appids in one keyless call (`IStoreBrowseService/GetItems`).
  Collapses the previous N-per-game review calls.

### Removed

- The IsThereAnyDeal (ITAD) integration and `ITAD_API_KEY`: `get_deals`,
  `get_game_info`, `get_current_prices`, `get_price_history`. Deal discovery,
  batch prices and review scores are now Steam-native and keyless via
  `discover_deals`, `get_items` and `get_prices`, so the third-party dependency
  is gone. **Price history is no longer offered** — Steam exposes no price-history
  API (only SteamDB/ITAD track it), and we chose to stay Steam-only and
  dependency-free.

## [0.1.0]

### Added

- Initial release. Steam MCP server on the reusable carcass (`lib/`: http,
  rateLimit, cache, errors, logger, result) with tsup/tsc build, `node:test`,
  `.mcpb` manifest, `server.json`, live `check:api`, and GitHub Actions CI/release.
- Store/keyless tools: `search_games` (with price), `get_game` (price, genres,
  platforms, Metacritic, age rating, DLC, requirements, highlighted achievements),
  `get_game_reviews` (+ `review_language` / `type`), `get_review_histogram`,
  `get_prices` (batch), `get_specials`, `get_featured`, `get_game_news`,
  `get_global_achievements`, `get_current_players`, `get_wishlist`.
- Player tools (free `STEAM_API_KEY`): `resolve_vanity_url`, `get_player_summary`
  (with `visibility`), `get_owned_games`, `get_recently_played`,
  `get_player_achievements`, `get_game_achievements` (names + rarity). Private
  profiles return a clear `found: false` reason; `get_player_achievements`
  distinguishes a private profile from a game with no achievements.
- Region/locale aware via `STEAM_COUNTRY` / `STEAM_LANGUAGE`, with per-call
  `country` / `language` overrides on the store/search/detail tools.
