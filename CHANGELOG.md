# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-07-16

### Changed

- Raise runtime floor to Node ≥ 20 (was ≥ 18)
  ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).

### Added

- Add a `steam_machine` compat field/filter to `get_items`, `discover_games` and
  `get_wishlist`, distinguishing Steam Machine support from general `steam_os`
  ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).
- Add `get_followed_games` tool — a player's Steam store follows list (keyless)
  ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).
- Add `get_player_bans` tool — VAC/game/community/economy ban status
  ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).
- Add Steam level to `get_player_summary`'s response
  ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).

### Fixed

- Fix `get_followed_games` erroring out when just the count lookup fails
  ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).
- Fix a `RateLimiter` edge case that could misfire under a clock near the epoch
  ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).

## [0.6.0] - 2026-07-12

### Added

- Add `get_friend_list` tool — a player's Steam friends (name, online state,
  current game, friends-since); requires `STEAM_API_KEY` and a public friends
  list ([2d21075](https://github.com/Grinv/steam-games-mcp/commit/2d21075)).
- Add `find_friends_who_own` tool — which friends own given appid(s) and hours
  played, checked against each friend's full owned-games list (unlike
  `get_owned_games` / `get_friend_list`, never capped to the top 50 by
  playtime); friends with a private library are reported separately, not
  counted as non-owners
  ([2d21075](https://github.com/Grinv/steam-games-mcp/commit/2d21075)).

### Fixed

- Fix `get_wishlist`'s `include_details`: Steam's `GetWishlistSortedFiltered`
  only enriches roughly the first 100 entries regardless of pagination, so
  filters silently missed the rest on bigger wishlists. The response now
  reports `enriched` (how many entries got store data) alongside `total`, with
  a `note` when Steam truncates it
  ([2d21075](https://github.com/Grinv/steam-games-mcp/commit/2d21075)).

## [0.5.0] - 2026-07-09

Richer store cards and catalog/wishlist discovery for the SteamOS / Steam
Machine era.

### Added

- Add `steam_os_compat_category` and `steam_frame_compat_category`
  compatibility ratings, surfaced as `steam_os`/`steam_frame` fields on
  `get_items`/`discover_games` (same `verified`/`playable`/`unsupported`/`unknown`
  scale as `steam_deck`), with matching `discover_games` filters
  ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).
- Add popular user tags (e.g. `Roguelike`, `Souls-like`) to `get_items`/
  `discover_games` cards, resolved from Steam's tag dictionary
  (`IStoreService/GetTagList`); `discover_games` gains a `tags` filter (AND,
  case-insensitive) ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).
- Add a `platforms` field (native `windows`/`mac`/`linux` builds) to
  `get_items`, `discover_games` and `get_wishlist` detailed cards, with a
  matching `platform` filter on `discover_games`/`get_wishlist`
  ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).
- Add `get_wishlist`'s `include_details` — full store cards (price/discount,
  review %, Deck/SteamOS/Frame compat, tags, release) via
  `IWishlistService/GetWishlistSortedFiltered`, filterable by `tags`,
  `platform`, `steam_deck`/`steam_os`/`steam_frame`, `min_review` and
  `min_discount`/`on_sale_only`, with a pre-cap `matched` count
  ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).
- Add `discount_end` (ISO 8601 UTC) to `get_items`, `discover_games` and
  `get_wishlist` detailed cards for discounted games; not carried by
  `get_game`/`get_prices` ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).
- Add `store_url` to `get_items`, `discover_games` and `get_wishlist` (light
  and detailed) cards, linking to each game's Steam store page
  ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).

### Changed

- Dedupe concurrent cache fetches for the same key, so racing store tools
  (e.g. multiple `get_items`/`discover_games` calls on a cold cache) no longer
  trigger redundant upstream requests like `GetTagList`
  ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).

### Fixed

- Fix `discover_games`/`get_wishlist`'s `tags` filter silently returning zero
  results when Steam's tag dictionary (`IStoreService/GetTagList`) is
  unavailable — now returns a clear error instead; tag display without a
  filter still degrades gracefully to an empty list
  ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).
- Fix `get_wishlist`'s `country`/`language` silently no-oping when passed
  without any other filter — now switches to the detailed (store-card) view,
  same as any other filter
  ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).

## [0.4.6] - 2026-06-30

### Fixed

- Fix unfilled optional `.mcpb` fields (Steam ID, API key) leaking as the
  literal placeholder string `${user_config.x}` instead of empty, wrongly
  turning on `web.configured` and causing Steam to reject requests with 403
  ([f9d0318](https://github.com/Grinv/steam-games-mcp/commit/f9d0318)).

## [0.4.5] - 2026-06-30

### Fixed

- Fix the `.mcpb` bundle not being self-contained: tsup left `dependencies`
  external, so `dist/index.js` crashed with `ERR_MODULE_NOT_FOUND` standalone;
  runtime deps are now inlined via `noExternal`
  ([c24a072](https://github.com/Grinv/steam-games-mcp/commit/c24a072)).

### Changed

- Minify the build with no sourcemap, shrinking `dist/index.js` from ~1.1 MB
  to ~620 KB ([c24a072](https://github.com/Grinv/steam-games-mcp/commit/c24a072)).

## [0.4.4] - 2026-06-30

### Fixed

- Fix strict MCP clients (e.g. Claude Desktop) disconnecting immediately: the
  logging sink mirrored the startup line to the client before the
  `initialize` handshake completed; client log mirroring now activates only
  after `initialized`
  ([0194f04](https://github.com/Grinv/steam-games-mcp/commit/0194f04)).

## [0.4.3] - 2026-06-30

### Added

- Add `environmentVariables` (`STEAM_API_KEY`, `STEAM_ID`, `STEAM_COUNTRY`,
  `STEAM_LANGUAGE`) to `server.json` for both packages, so registry consumers
  can surface every config option
  ([9f6bdef](https://github.com/Grinv/steam-games-mcp/commit/9f6bdef)).

## [0.4.2] - 2026-06-30

### Fixed

- Fix the v0.4.1 MCP Registry publish failing schema validation: `server.json`'s
  `description` exceeded the registry's 100-char cap; shortened it
  ([dfb1c6d](https://github.com/Grinv/steam-games-mcp/commit/dfb1c6d)).

## [0.4.1] - 2026-06-30

### Added

- Add MCP Registry publishing as `io.github.Grinv/steam-games-mcp`, listing
  both the npm and `.mcpb` packages; the release workflow now publishes
  automatically via `mcp-publisher` with GitHub OIDC
  ([c61d0ac](https://github.com/Grinv/steam-games-mcp/commit/c61d0ac)).

## [0.4.0] - 2026-06-30

### Added

- Add the MCP logging capability: the server mirrors stderr log lines to the
  client as `notifications/message`, gated by the same `LOG_LEVEL` threshold
  ([649ce1c](https://github.com/Grinv/steam-games-mcp/commit/649ce1c)).

### Fixed

- Fix the logger's stderr prefix showing `[mal-mcp]` (template leftover)
  instead of `[steam-games-mcp]`
  ([649ce1c](https://github.com/Grinv/steam-games-mcp/commit/649ce1c)).
- Fix `redact()` not masking the Steam Web API `key` query param, which could
  leak into debug logs and the new MCP logging channel
  ([649ce1c](https://github.com/Grinv/steam-games-mcp/commit/649ce1c)).

## [0.3.0] - 2026-06-30

### Changed

- Merge `discover_deals` into `discover_games` (breaking): pass
  `min_discount` for deals, `released_after`/`released_within_days` for new
  releases, `steam_deck` for Deck-capable games, and `min_review`/
  `min_reviews` for rating, in any combination. Migrate
  `discover_deals({ min_discount })` calls to `discover_games({ min_discount })`
  ([4e62041](https://github.com/Grinv/steam-games-mcp/commit/4e62041)).

### Added

- Add `STEAM_ID` config (env/`.mcpb`): a default SteamID64 or vanity name that
  player tools (`get_wishlist`, `get_owned_games`, `get_recently_played`,
  `get_player_summary`, `get_player_achievements`) fall back to when
  `steamid` is omitted ([4e62041](https://github.com/Grinv/steam-games-mcp/commit/4e62041)).
- Add a `name` parameter to `get_game` as an alternative to `appid`, resolved
  to the closest store match
  ([4e62041](https://github.com/Grinv/steam-games-mcp/commit/4e62041)).
- Add a per-call `language` override to `get_player_achievements` for
  achievement names/descriptions, matching `get_game_achievements`
  ([4e62041](https://github.com/Grinv/steam-games-mcp/commit/4e62041)).
- Add `discover_games` — find games catalog-wide (keyless) by discount,
  release recency, Steam Deck compatibility and review quality, sorted by
  popularity so results hold real, Deck-rated games
  ([4e62041](https://github.com/Grinv/steam-games-mcp/commit/4e62041)).
- Add Steam Deck compatibility (`verified`/`playable`/`unsupported`/`unknown`)
  to `get_items`/`discover_games` (via `include_platforms`), with a
  `steam_deck` filter on `discover_games`
  ([4e62041](https://github.com/Grinv/steam-games-mcp/commit/4e62041)).

## [0.2.0] - 2026-06-30

### Changed

- Rename the package to `steam-games-mcp` (npm `steam-mcp` was taken);
  install with `npx -y steam-games-mcp`
  ([3a8577b](https://github.com/Grinv/steam-games-mcp/commit/3a8577b)).

### Added

- Add `discover_deals` — catalog-wide deal discovery via
  `IStoreQueryService/Query`, returning discount %, price, review % and
  release date for games at/above a discount, with optional `min_review`/
  `min_reviews` thresholds
  ([1e1bd7f](https://github.com/Grinv/steam-games-mcp/commit/1e1bd7f)).
- Add `get_items` — batch store cards (price/discount, review %, release
  date) for a list of appids in one keyless call
  (`IStoreBrowseService/GetItems`), replacing per-game review calls
  ([e4d88ea](https://github.com/Grinv/steam-games-mcp/commit/e4d88ea)).

### Fixed

- Fix `get_specials` missing `get_prices` from the manifest and referencing a
  stale, already-removed `get_deals` tool in its description
  ([e14b05b](https://github.com/Grinv/steam-games-mcp/commit/e14b05b)).

### Removed

- Remove the IsThereAnyDeal (ITAD) integration and `ITAD_API_KEY`
  (`get_deals`, `get_game_info`, `get_current_prices`, `get_price_history`):
  deal discovery, batch prices and reviews are now Steam-native via
  `discover_deals`/`get_items`/`get_prices`. Price history is no longer
  offered, since Steam exposes no price-history API
  ([1e1bd7f](https://github.com/Grinv/steam-games-mcp/commit/1e1bd7f)).

## [0.1.0] - 2026-06-30

### Added

- Initial release: Steam MCP server on the reusable carcass (`lib/`),
  tsup/tsc build, `node:test`, `.mcpb` manifest, `server.json`, live
  `check:api`, and GitHub Actions CI/release
  ([95be5ec](https://github.com/Grinv/steam-games-mcp/commit/95be5ec)).
- Add store/keyless tools: `search_games`, `get_game`, `get_game_reviews`,
  `get_review_histogram`, `get_prices`, `get_specials`, `get_featured`,
  `get_game_news`, `get_global_achievements`, `get_current_players`,
  `get_wishlist`
  ([95be5ec](https://github.com/Grinv/steam-games-mcp/commit/95be5ec),
  [808c0bc](https://github.com/Grinv/steam-games-mcp/commit/808c0bc),
  [b4e0a10](https://github.com/Grinv/steam-games-mcp/commit/b4e0a10)).
- Add player tools (free `STEAM_API_KEY`): `resolve_vanity_url`,
  `get_player_summary`, `get_owned_games`, `get_recently_played`,
  `get_player_achievements`, `get_game_achievements`; private profiles return
  a clear `found: false` reason
  ([95be5ec](https://github.com/Grinv/steam-games-mcp/commit/95be5ec),
  [c31b09a](https://github.com/Grinv/steam-games-mcp/commit/c31b09a),
  [c663715](https://github.com/Grinv/steam-games-mcp/commit/c663715),
  [0239c0e](https://github.com/Grinv/steam-games-mcp/commit/0239c0e)).
- Add region/locale support via `STEAM_COUNTRY`/`STEAM_LANGUAGE`, with
  per-call `country`/`language` overrides on the store/search/detail tools
  ([048f8fe](https://github.com/Grinv/steam-games-mcp/commit/048f8fe)).
