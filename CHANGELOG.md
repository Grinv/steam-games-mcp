# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Per-call overrides for the server defaults: `country` (and `language` where it
  applies) on `search_games`, `get_game`, `get_specials`, `get_featured`,
  `get_prices`, `get_game_achievements`, `get_deals`, `get_price_history` — so an
  agent can e.g. compare prices across regions in one conversation. Unset → the
  configured `STEAM_COUNTRY` / `STEAM_LANGUAGE` default applies.
- `get_game_reviews` gains `review_language` and `type` (positive/negative);
  `get_deals` gains `sort` and a client-side `max_price` filter.

### Added

- `get_current_players` — live concurrent player count for a game (no key).
- `get_review_histogram` — review trend over time: long-term (monthly) history
  plus recent per-day breakdown with positive % (no key).
- `get_wishlist` — a player's wishlist appids by SteamID64, sorted by priority
  (no key; returns found:false when the wishlist/profile is private).
- `get_prices` — batch current price + discount for many appids in one call
  (no key); efficient for checking a whole wishlist for deals.
- `get_game_achievements` — the full achievement list for a game (names,
  descriptions, hidden flag) merged with global unlock % (rarity). Requires a
  key (the schema endpoint needs one); `get_game` also now surfaces a keyless
  `achievements_highlighted` sample.
- `get_current_prices` (ITAD) — batch current Steam price/discount for a LIST of
  appids in two calls total (bulk appid→id lookup + batch prices), with
  historic_low and on_sale per game. The array-input batch tool.
- `get_owned_games` / `get_recently_played` now return `found: false` with a
  clear reason when the profile/game-details are private (instead of a
  misleading empty list); `get_player_summary` already exposes `visibility`.
- `get_player_achievements` now distinguishes a private profile from a game that
  simply has no achievements: on failure it checks the game schema and reports a
  precise reason (only on the failure path — the happy path stays one call).
- `get_game_info` (ITAD) — one call returns the Steam appid, Steam review score
  (%) + count, Metacritic, current players (recent/peak), tags, developers and
  release date. Bridges `get_deals` → review-quality filtering by `itad_id`.
- `get_deals` now also returns `historic_low` / `is_historic_low`; and gains
  `sort` + a client-side `max_price`. `get_price_history` gains a `since` window
  (so `lowest` can be a true all-time low) and a `country` override.
- IsThereAnyDeal integration (optional `ITAD_API_KEY`): `get_deals` —
  catalog-wide current discounts, biggest first, with a `min_cut` filter (e.g.
  ">80% off"), scoped to Steam by default; and `get_price_history` — a game's
  price history and all-time low by Steam appid. These cover the SteamDB-style
  features the Steam APIs don't expose, without scraping.

### Changed

- `search_games` results now include a `price` (currency, final, initial,
  discount_percent) — the Storefront returns it; it was previously dropped.
- `get_game` now also returns `controller_support`, `achievements_total`,
  `supported_languages`, `dlc`, `demos`, `content_descriptors` (mature flags),
  `base_game` (for DLC), and `drm_notice` / `account_notice` warnings.

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
