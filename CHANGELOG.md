# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-07-16

### Changed

- Raise runtime floor to Node ≥ 20 (was ≥ 18).

### Added

- Add a `steam_machine` compat field/filter to `get_items`, `discover_games` and
  `get_wishlist`, distinguishing Steam Machine support from general `steam_os`.
- Add `get_followed_games` tool — a player's Steam store follows list (keyless).
- Add `get_player_bans` tool — VAC/game/community/economy ban status.
- Add Steam level to `get_player_summary`'s response.

### Fixed

- Fix `get_followed_games` erroring out when just the count lookup fails.
- Clear `dist-tests/` before rebuilding in `build-tests.mjs`, so deleted/renamed
  test files can't leave stale compiled copies behind.
- Fix a `RateLimiter` edge case that could misfire under a clock near the epoch.

### Internal

- Split the grown `clients/web.ts` / `tools/web.ts` into smaller per-concern
  files.
- Split `steam.test.ts` into per-domain test files with shared fixtures.
- Use `t.mock` / `t.after` (Node 20's stable `node:test` APIs) instead of
  manual restore/`finally` boilerplate in tests.
- Group integration tests into `describe()` blocks per tool.

## [0.6.0] - 2026-07-12

### Added

- Add `get_friend_list` tool — a player's Steam friends (name, online state,
  current game, friends-since); requires `STEAM_API_KEY` and a public friends
  list.
- Add `find_friends_who_own` tool — which friends own given appid(s) and hours
  played, checked against each friend's full owned-games list (unlike
  `get_owned_games` / `get_friend_list`, never capped to the top 50 by
  playtime); friends with a private library are reported separately, not
  counted as non-owners.

### Fixed

- Fix `get_wishlist`'s `include_details`: Steam's `GetWishlistSortedFiltered`
  only enriches roughly the first 100 entries regardless of pagination, so
  filters silently missed the rest on bigger wishlists. The response now
  reports `enriched` (how many entries got store data) alongside `total`, with
  a `note` when Steam truncates it.

## [0.5.0] - 2026-07-09

Richer store cards and catalog/wishlist discovery for the SteamOS / Steam
Machine era, plus a DRY/KISS refactor of the store-service layer.

### Added

- Add `steam_os_compat_category` and `steam_frame_compat_category`
  compatibility ratings, surfaced as `steam_os`/`steam_frame` fields on
  `get_items`/`discover_games` (same `verified`/`playable`/`unsupported`/`unknown`
  scale as `steam_deck`), with matching `discover_games` filters.
- Add popular user tags (e.g. `Roguelike`, `Souls-like`) to `get_items`/
  `discover_games` cards, resolved from Steam's tag dictionary
  (`IStoreService/GetTagList`); `discover_games` gains a `tags` filter (AND,
  case-insensitive).
- Add a `platforms` field (native `windows`/`mac`/`linux` builds) to
  `get_items`, `discover_games` and `get_wishlist` detailed cards, with a
  matching `platform` filter on `discover_games`/`get_wishlist`.
- Add `get_wishlist`'s `include_details` — full store cards (price/discount,
  review %, Deck/SteamOS/Frame compat, tags, release) via
  `IWishlistService/GetWishlistSortedFiltered`, filterable by `tags`,
  `platform`, `steam_deck`/`steam_os`/`steam_frame`, `min_review` and
  `min_discount`/`on_sale_only`, with a pre-cap `matched` count.
- Add `discount_end` (ISO 8601 UTC) to `get_items`, `discover_games` and
  `get_wishlist` detailed cards for discounted games; not carried by
  `get_game`/`get_prices`.
- Add `store_url` to `get_items`, `discover_games` and `get_wishlist` (light
  and detailed) cards, linking to each game's Steam store page.

### Fixed

- Fix `discover_games`/`get_wishlist`'s `tags` filter silently returning zero
  results when Steam's tag dictionary (`IStoreService/GetTagList`) is
  unavailable — now returns a clear error instead; tag display without a
  filter still degrades gracefully to an empty list.
- Fix `get_wishlist`'s `country`/`language` silently no-oping when passed
  without any other filter — now switches to the detailed (store-card) view,
  same as any other filter.
- Add a live `check:api` check for `IWishlistService/GetWishlistSortedFiltered`,
  the endpoint backing `get_wishlist`'s `include_details`/filters.

### Internal

- Refactor the store-service layer for DRY/KISS: split `format/web.ts` into
  `format/web.ts` (player data) and `format/store.ts` (keyless store
  services), extract shared `baseCard`/`storeItemFilter` helpers and centralize
  tool param schemas in `tools/common.ts`; no behavior change.
- Dedupe concurrent `TtlCache` fetches for the same key, avoiding redundant
  `GetTagList` calls when multiple store tools race on a cold cache.
- Expand test coverage to ~94% lines (112 tests): store card builders,
  `storeItemFilter`, the cache dedup, and formatter fallbacks for sparse/
  malformed payloads.
- Add an e2e smoke test that drives the built bundle over stdio via a spawned
  `node dist/index.js`, asserting handshake, tool registration and player-tool
  gating.
- Fix the e2e smoke test failing on Node 18 by shipping a
  `{"type":"module"}` package.json alongside the sandboxed bundle, matching
  the real npm/`.mcpb` artifact.

### Dependencies

- Bump dev dependencies: `@types/node` 26.1.1, `prettier` 3.9.4,
  `typescript-eslint` 8.63.0 (TypeScript 7 deferred until `typescript-eslint`
  supports it).

## [0.4.6] - 2026-06-30

### Fixed

- Fix unfilled optional `.mcpb` fields (Steam ID, API key) leaking as the
  literal placeholder string `${user_config.x}` instead of empty, wrongly
  turning on `web.configured` and causing Steam to reject requests with 403.

## [0.4.5] - 2026-06-30

### Fixed

- Fix the `.mcpb` bundle not being self-contained: tsup left `dependencies`
  external, so `dist/index.js` crashed with `ERR_MODULE_NOT_FOUND` standalone;
  runtime deps are now inlined via `noExternal`.

### Changed

- Minify the build with no sourcemap, shrinking `dist/index.js` from ~1.1 MB
  to ~620 KB.

## [0.4.4] - 2026-06-30

### Fixed

- Fix strict MCP clients (e.g. Claude Desktop) disconnecting immediately: the
  logging sink mirrored the startup line to the client before the
  `initialize` handshake completed; client log mirroring now activates only
  after `initialized`.

### Changed

- README: add a direct `.mcpb` download link and Claude Desktop / MCP
  Registry install notes.

## [0.4.3] - 2026-06-30

### Added

- Add `environmentVariables` (`STEAM_API_KEY`, `STEAM_ID`, `STEAM_COUNTRY`,
  `STEAM_LANGUAGE`) to `server.json` for both packages, so registry consumers
  can surface every config option.

## [0.4.2] - 2026-06-30

### Fixed

- Fix the v0.4.1 MCP Registry publish failing schema validation: `server.json`'s
  `description` exceeded the registry's 100-char cap; shortened it.

## [0.4.1] - 2026-06-30

### Added

- Add MCP Registry publishing as `io.github.Grinv/steam-games-mcp`, listing
  both the npm and `.mcpb` packages; the release workflow now publishes
  automatically via `mcp-publisher` with GitHub OIDC.

## [0.4.0] - 2026-06-30

### Added

- Add the MCP logging capability: the server mirrors stderr log lines to the
  client as `notifications/message`, gated by the same `LOG_LEVEL` threshold.

### Changed

- Split `src/format.ts` into `src/format/` (`storefront.ts`, `web.ts`,
  `shared.ts`); no behavior change.
- Enforce the 80%-lines coverage gate in `npm run test:coverage` locally, not
  just in CI (falls back to report-only on Node < 22.8).

### Fixed

- Fix the logger's stderr prefix showing `[mal-mcp]` (template leftover)
  instead of `[steam-games-mcp]`.
- Fix `redact()` not masking the Steam Web API `key` query param, which could
  leak into debug logs and the new MCP logging channel.

### Removed

- Remove dead `src/lib/tokenStore.ts`, a MAL OAuth-token leftover from the
  template, unused here.

## [0.3.0]

### Changed

- Merge `discover_deals` into `discover_games` (breaking): pass
  `min_discount` for deals, `released_after`/`released_within_days` for new
  releases, `steam_deck` for Deck-capable games, and `min_review`/
  `min_reviews` for rating, in any combination. Migrate
  `discover_deals({ min_discount })` calls to `discover_games({ min_discount })`.

### Added

- Add `STEAM_ID` config (env/`.mcpb`): a default SteamID64 or vanity name that
  player tools (`get_wishlist`, `get_owned_games`, `get_recently_played`,
  `get_player_summary`, `get_player_achievements`) fall back to when
  `steamid` is omitted.
- Add a `name` parameter to `get_game` as an alternative to `appid`, resolved
  to the closest store match.
- Add a per-call `language` override to `get_player_achievements` for
  achievement names/descriptions, matching `get_game_achievements`.
- Add `discover_games` — find games catalog-wide (keyless) by discount,
  release recency, Steam Deck compatibility and review quality, sorted by
  popularity so results hold real, Deck-rated games.
- Add Steam Deck compatibility (`verified`/`playable`/`unsupported`/`unknown`)
  to `get_items`/`discover_games` (via `include_platforms`), with a
  `steam_deck` filter on `discover_games`.

### Docs

- README: add natural-language example queries and a step-by-step
  credentials setup guide.

## [0.2.0]

### Changed

- Rename the package to `steam-games-mcp` (npm `steam-mcp` was taken);
  install with `npx -y steam-games-mcp`.

### Added

- Add `discover_deals` — catalog-wide deal discovery via
  `IStoreQueryService/Query`, returning discount %, price, review % and
  release date for games at/above a discount, with optional `min_review`/
  `min_reviews` thresholds.
- Add `get_items` — batch store cards (price/discount, review %, release
  date) for a list of appids in one keyless call
  (`IStoreBrowseService/GetItems`), replacing per-game review calls.

### Removed

- Remove the IsThereAnyDeal (ITAD) integration and `ITAD_API_KEY`
  (`get_deals`, `get_game_info`, `get_current_prices`, `get_price_history`):
  deal discovery, batch prices and reviews are now Steam-native via
  `discover_deals`/`get_items`/`get_prices`. Price history is no longer
  offered, since Steam exposes no price-history API.

## [0.1.0]

### Added

- Initial release: Steam MCP server on the reusable carcass (`lib/`),
  tsup/tsc build, `node:test`, `.mcpb` manifest, `server.json`, live
  `check:api`, and GitHub Actions CI/release.
- Add store/keyless tools: `search_games`, `get_game`, `get_game_reviews`,
  `get_review_histogram`, `get_prices`, `get_specials`, `get_featured`,
  `get_game_news`, `get_global_achievements`, `get_current_players`,
  `get_wishlist`.
- Add player tools (free `STEAM_API_KEY`): `resolve_vanity_url`,
  `get_player_summary`, `get_owned_games`, `get_recently_played`,
  `get_player_achievements`, `get_game_achievements`; private profiles return
  a clear `found: false` reason.
- Add region/locale support via `STEAM_COUNTRY`/`STEAM_LANGUAGE`, with
  per-call `country`/`language` overrides on the store/search/detail tools.
