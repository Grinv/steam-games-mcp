# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Internal

- Added an **e2e smoke test** that drives the real built bundle the way a client
  does — a spawned `node dist/index.js` over stdio, run from a dir with no
  node_modules — asserting it handshakes, registers all tools, and gates player
  tools. Covers the integration boundary that the recent 0.4.4–0.4.6 bugs hid in
  (in-memory unit tests never ran the actual artifact).
- Fixed that e2e smoke test failing on **Node 18**: the sandbox ran the ESM
  bundle as a bare `index.js` with no `package.json`, so Node < 20.19 (no ESM
  syntax auto-detection) parsed it as CommonJS and the child died with "Cannot
  use import statement outside a module". The sandbox now ships a
  `{"type":"module"}` package.json, mirroring the real npm/.mcpb artifact.

## [0.4.6] - 2026-06-30

### Fixed

- **Unfilled `.mcpb` optional fields leaked as literal `${user_config.x}`.** When
  an optional field (Steam ID, API key) is left blank in the Claude Desktop
  install form, `.mcpb` passes the **unsubstituted placeholder string** (not "")
  as the env var. A non-empty placeholder was taken as a real value: an unset key
  became `STEAM_API_KEY="${user_config.steam_api_key}"`, so `web.configured` went
  true and the server sent garbage to Steam → **403**; an unset `STEAM_ID` became
  a bogus default player. `loadConfig` now treats `${...}` placeholders as unset
  (like empty strings). Adds `config.test.ts`.

## [0.4.5] - 2026-06-30

### Fixed

- **`.mcpb` bundle was not self-contained.** Despite `bundle: true`, tsup leaves
  `dependencies` external, so `dist/index.js` still imported `@modelcontextprotocol/sdk`
  and `zod` at runtime — but the `.mcpb` ships no `node_modules`, so the server
  crashed standalone with `ERR_MODULE_NOT_FOUND` (masked only where the client
  installs deps for us). Added `noExternal` to inline all runtime deps; a new
  `bundle.test.ts` guards that the build stays self-contained.

### Changed

- Build is now **minified** with **no sourcemap** → `dist/index.js` ~1.1 MB → ~620 KB,
  leaner npm tarball and `.mcpb`. (We log `err.message`, not raw stacks, so
  diagnostics are unaffected.)

## [0.4.4] - 2026-06-30

### Fixed

- **Server disconnected immediately in strict clients (e.g. Claude Desktop).** The
  MCP logging sink (added in 0.4.0) mirrored the startup "ready" line to the client
  as a `notifications/message` right after `connect()` — i.e. **before** the
  `initialize` handshake completed, violating the MCP lifecycle, so strict clients
  dropped the connection. Client log mirroring now activates only after
  `initialized`; pre-init logs go to stderr only. Regression test added.

### Changed

- README: direct one-click `.mcpb` download link + Claude Desktop / MCP Registry
  install notes.

## [0.4.3] - 2026-06-30

### Added

- **Self-describing registry entry.** `server.json` now declares
  `environmentVariables` (`STEAM_API_KEY`, `STEAM_ID`, `STEAM_COUNTRY`,
  `STEAM_LANGUAGE`) on both packages, so registry consumers (agents, installers)
  can surface every config option — previously only `STEAM_API_KEY` showed up
  (and only because tools inferred it).

## [0.4.2] - 2026-06-30

### Fixed

- **MCP Registry publish.** The v0.4.1 registry publish failed schema validation —
  `server.json`'s `description` was 118 chars but the registry caps it at 100.
  Shortened it (npm/manifest are unaffected) and added a `version.test.ts` guard.
  This is the first release to actually land in the registry.

## [0.4.1] - 2026-06-30

### Added

- **MCP Registry publishing setup** (`registry.modelcontextprotocol.io`)
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
