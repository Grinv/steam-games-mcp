# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Published to the official MCP Registry** (`registry.modelcontextprotocol.io`)
  as `io.github.Grinv/steam-games-mcp`, listing both the npm and `.mcpb` packages.
  `package.json` gains an `mcpName` marker (npm ownership verification) and
  `server.json` lists both packages with the `.mcpb` `fileSha256`. The release
  workflow now publishes to the registry automatically via `mcp-publisher` with
  GitHub OIDC (no token), injecting the freshly-packed bundle's hash.

## [0.4.0] - 2026-06-30

### Added

- **MCP logging capability.** The server now declares the `logging` capability and
  mirrors its stderr log lines to the connected client as `notifications/message`,
  so MCP hosts can surface server logs in their UI and adjust verbosity at runtime
  via `logging/setLevel`. stderr logging is unchanged; the new channel is
  best-effort, credential-redacted, and gated by the same `LOG_LEVEL` threshold.

### Changed

- **Internal: `src/format.ts` split into `src/format/`** (`storefront.ts`, `web.ts`,
  shared helpers in `shared.ts`), mirroring the `clients/` and `tools/` layout. No
  behavior change; public tool output is identical.
- `npm run test:coverage` now enforces the 80%-lines gate locally (previously only
  in CI), so coverage regressions are caught before pushing. Falls back to
  report-only on Node < 22.8 (the threshold flag's minimum).

### Fixed

- Logger stderr prefix said `[mal-mcp]` (template leftover); now `[steam-games-mcp]`.
- `redact()` now masks the Steam Web API `key` query param. It travels in request
  URLs that are logged at debug level, so it could previously leak into logs (and,
  with the new MCP logging channel, to clients).

### Removed

- Dead `src/lib/tokenStore.ts` — a MAL OAuth-token persistence leftover from the
  template, unused here (Steam auth is a single env key, no token rotation).

## [0.3.0]

### Changed

- **`discover_deals` merged into `discover_games`** (breaking). They were the same
  catalog query with different presets, so they collapse into one tool. Pass
  `min_discount` for deals, `released_after` / `released_within_days` for new
  releases, `steam_deck` for Deck-capable games, and `min_review` / `min_reviews`
  for rating — in any combination. Migration: replace
  `discover_deals({ min_discount })` with `discover_games({ min_discount })`.

### Added

- `STEAM_ID` config (env / `.mcpb` user_config): set a default player — a 17-digit
  SteamID64 or a vanity name (resolved once via the Web API) — so the player tools
  (`get_wishlist`, `get_owned_games`, `get_recently_played`, `get_player_summary`,
  `get_player_achievements`) default to you. Their `steamid` argument is now
  optional and falls back to `STEAM_ID`; ask "my wishlist" without passing an ID.
- `get_game` now accepts a `name` as an alternative to `appid` — a title is
  resolved to the closest store match, so you can look a game up without an appid.
- `get_player_achievements` gains a per-call `language` override for achievement
  names/descriptions, matching `get_game_achievements` (falls back to `STEAM_LANGUAGE`).
- `discover_games` — find games catalog-wide (keyless) by discount, release recency
  (`released_after` / `released_within_days`), **Steam Deck** compatibility and
  review quality, in any combination. Sorts the catalog by popularity so the scanned
  window holds real games with genuine Deck ratings and review counts (the default
  appid order surfaced Deck-untested shovelware). Answers both "games >80% off with
  90%+ reviews" and "recent well-reviewed games that run on Steam Deck".
- **Steam Deck compatibility** (`verified` / `playable` / `unsupported` / `unknown`)
  is reported by `get_items` and `discover_games` (via `include_platforms`), with a
  `steam_deck` filter on `discover_games`. Note: Steam's catalog API has no
  server-side Deck filter or release-date sort, so the Deck/recency/review filters
  are applied over the popularity-sorted page (raise `count` for stricter filters).

### Docs

- README: natural-language example queries and a step-by-step
  "Getting your credentials" guide (API key, Steam ID, public profile).

## [0.2.0]

### Changed

- **Renamed the package to `steam-games-mcp`** (npm `steam-mcp` is taken by an
  unrelated project). The GitHub repo, npm package, `.mcpb` and config snippets
  all use `steam-games-mcp`; install with `npx -y steam-games-mcp`.

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
