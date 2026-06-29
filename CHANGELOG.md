# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `get_current_players` — live concurrent player count for a game (no key).
- `get_review_histogram` — review trend over time: long-term (monthly) history
  plus recent per-day breakdown with positive % (no key).
- `get_wishlist` — a player's wishlist appids by SteamID64, sorted by priority
  (no key; returns found:false when the wishlist/profile is private).

## [0.1.0]

### Added

- Initial release. Steam MCP server with a hybrid backend.
- Storefront tools (no key): `search_games`, `get_game`, `get_game_reviews`,
  `get_specials`, `get_featured`.
- Web API tools: `get_game_news` and `get_global_achievements` (work without a
  key), plus key-gated `resolve_vanity_url`, `get_player_summary`,
  `get_owned_games`, `get_recently_played`, `get_player_achievements`.
- Region/locale aware via `STEAM_COUNTRY` (cc) and `STEAM_LANGUAGE` (l); optional
  `STEAM_API_KEY` for player data.
- Built on the reusable MCP carcass (`lib/`: http, rateLimit, cache, errors,
  logger, result) with tsup/tsc build, `node:test` setup, `.mcpb` manifest,
  `server.json`, live `check:api` health checks, and GitHub Actions CI/release
  (npm publish via Trusted Publishing).
