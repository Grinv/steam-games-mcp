# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] - 2026-07-18

### Added

- Add `compare_players` — shared games between two players' full libraries, with each one's playtime ([a36baa9](https://github.com/Grinv/steam-games-mcp/commit/a36baa9)).
- Add guided prompts (`what_should_i_play`, `is_it_worth_buying`, `deals_digest`) that orchestrate existing tools for common questions ([a36baa9](https://github.com/Grinv/steam-games-mcp/commit/a36baa9)).

### Fixed

- Fix the fatal-startup error message showing the generic template name instead of `steam-games-mcp` ([1becccf](https://github.com/Grinv/steam-games-mcp/commit/1becccf)).

## [0.7.0] - 2026-07-16

### Changed

- Raise runtime floor to Node ≥ 20 (was ≥ 18) ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).

### Added

- Add a `steam_machine` compat field/filter (separate from `steam_os`) to `get_items`, `discover_games` and `get_wishlist` ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).
- Add `get_followed_games` — a player's Steam store follows list, keyless ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).
- Add `get_player_bans` — VAC/game/community/economy ban status ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).
- Expose Steam level in `get_player_summary`'s response ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).

### Fixed

- Fix `get_followed_games` erroring out when just the count lookup fails ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).
- Prevent a `RateLimiter` edge case that could misfire under a clock near the epoch ([58d978c](https://github.com/Grinv/steam-games-mcp/commit/58d978c)).

## [0.6.0] - 2026-07-12

### Added

- Add `get_friend_list` — a player's Steam friends (status, current game, friends-since) ([2d21075](https://github.com/Grinv/steam-games-mcp/commit/2d21075)).
- Add `find_friends_who_own` — which friends own given appid(s) and their playtime, checked against each friend's full library ([2d21075](https://github.com/Grinv/steam-games-mcp/commit/2d21075)).

### Fixed

- Fix `get_wishlist`'s `include_details` silently missing entries past ~100 on big wishlists — the response now reports `enriched` alongside `total` ([2d21075](https://github.com/Grinv/steam-games-mcp/commit/2d21075)).

## [0.5.0] - 2026-07-09

Richer store cards and catalog/wishlist discovery for the SteamOS / Steam Machine era.

### Added

- Add `steam_os`/`steam_frame` compatibility ratings to `get_items`/`discover_games`, with matching filters ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).
- Add popular user tags to `get_items`/`discover_games` cards, with a matching `tags` filter ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).
- Add a `platforms` field (native Windows/Mac/Linux) to store cards, with a matching `platform` filter ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).
- Add `get_wishlist`'s `include_details` — full store cards, filterable by tags, platform, compat rating, review and discount ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).
- Add `discount_end` (ISO 8601 UTC) to discounted store cards ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).
- Add `store_url` (Steam store page link) to `get_items`/`discover_games`/`get_wishlist` cards ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).

### Changed

- Dedupe concurrent cache fetches for the same key, avoiding redundant upstream requests on a cold cache ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).

### Fixed

- Return a clear error, instead of silently zero results, when the `tags` filter can't reach Steam's tag dictionary ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).
- Stop `get_wishlist`'s `country`/`language` from silently no-oping without another filter — it now always switches to the detailed view ([a01a3db](https://github.com/Grinv/steam-games-mcp/commit/a01a3db)).

## [0.4.6] - 2026-06-30

### Fixed

- Prevent unfilled optional `.mcpb` fields from leaking as the literal `${user_config.x}` string instead of empty, which caused 403s ([f9d0318](https://github.com/Grinv/steam-games-mcp/commit/f9d0318)).

## [0.4.5] - 2026-06-30

### Fixed

- Prevent the `.mcpb` bundle from crashing standalone (`ERR_MODULE_NOT_FOUND`) by inlining runtime deps instead of leaving them external ([c24a072](https://github.com/Grinv/steam-games-mcp/commit/c24a072)).

### Changed

- Minify the build with no sourcemap, shrinking `dist/index.js` from ~1.1 MB to ~620 KB ([c24a072](https://github.com/Grinv/steam-games-mcp/commit/c24a072)).

## [0.4.4] - 2026-06-30

### Fixed

- Stop strict MCP clients (e.g. Claude Desktop) from disconnecting immediately — log mirroring now starts only after `initialized` ([0194f04](https://github.com/Grinv/steam-games-mcp/commit/0194f04)).

## [0.4.3] - 2026-06-30

### Added

- Expose `environmentVariables` in `server.json` so registry consumers can surface every config option ([9f6bdef](https://github.com/Grinv/steam-games-mcp/commit/9f6bdef)).

## [0.4.2] - 2026-06-30

### Fixed

- Shorten `server.json`'s `description`, which exceeded the registry's 100-char cap and broke the v0.4.1 publish ([dfb1c6d](https://github.com/Grinv/steam-games-mcp/commit/dfb1c6d)).

## [0.4.1] - 2026-06-30

### Added

- Publish to the MCP Registry (npm + `.mcpb` packages), automated in the release workflow ([c61d0ac](https://github.com/Grinv/steam-games-mcp/commit/c61d0ac)).

## [0.4.0] - 2026-06-30

### Added

- Support the MCP logging capability, mirroring stderr log lines to the client as `notifications/message` ([649ce1c](https://github.com/Grinv/steam-games-mcp/commit/649ce1c)).

### Fixed

- Correct the logger's stderr prefix, which showed `[mal-mcp]` (template leftover) instead of `[steam-games-mcp]` ([649ce1c](https://github.com/Grinv/steam-games-mcp/commit/649ce1c)).
- Mask the Steam Web API `key` query param in `redact()`, which could leak into logs ([649ce1c](https://github.com/Grinv/steam-games-mcp/commit/649ce1c)).

## [0.3.0] - 2026-06-30

### Changed

- Merge `discover_deals` into `discover_games` (breaking) — pass `min_discount`, `released_after`, `steam_deck` or `min_review` in any combination ([4e62041](https://github.com/Grinv/steam-games-mcp/commit/4e62041)).
  Migrate `discover_deals({ min_discount })` calls to `discover_games({ min_discount })`.

### Added

- Add `STEAM_ID` config — a default SteamID64/vanity name that player tools fall back to when `steamid` is omitted ([4e62041](https://github.com/Grinv/steam-games-mcp/commit/4e62041)).
- Add a `name` parameter to `get_game` as an alternative to `appid`, resolved to the closest store match ([4e62041](https://github.com/Grinv/steam-games-mcp/commit/4e62041)).
- Add a per-call `language` override to `get_player_achievements`, matching `get_game_achievements` ([4e62041](https://github.com/Grinv/steam-games-mcp/commit/4e62041)).
- Add `discover_games` — find games catalog-wide by discount, recency, Steam Deck compatibility and review quality ([4e62041](https://github.com/Grinv/steam-games-mcp/commit/4e62041)).
- Add Steam Deck compatibility ratings to `get_items`/`discover_games`, with a matching filter ([4e62041](https://github.com/Grinv/steam-games-mcp/commit/4e62041)).

## [0.2.0] - 2026-06-30

### Changed

- Rename the package to `steam-games-mcp` (npm `steam-mcp` was taken) ([3a8577b](https://github.com/Grinv/steam-games-mcp/commit/3a8577b)).

### Added

- Add `discover_deals` — catalog-wide deal discovery by discount %, price and review %, with optional review thresholds ([1e1bd7f](https://github.com/Grinv/steam-games-mcp/commit/1e1bd7f)).
- Add `get_items` — batch store cards (price, discount, review %, release date) for a list of appids in one call ([e4d88ea](https://github.com/Grinv/steam-games-mcp/commit/e4d88ea)).

### Fixed

- Restore `get_prices` to the manifest and drop a stale, already-removed `get_deals` reference in `get_specials` ([e14b05b](https://github.com/Grinv/steam-games-mcp/commit/e14b05b)).

### Removed

- Remove the IsThereAnyDeal (ITAD) integration — deal discovery, batch prices and reviews are now Steam-native via `discover_deals`/`get_items`/`get_prices` ([1e1bd7f](https://github.com/Grinv/steam-games-mcp/commit/1e1bd7f)).
  Price history is no longer offered; Steam exposes no price-history API.

## [0.1.0] - 2026-06-30

### Added

- Initial release of the Steam MCP server, built on the reusable carcass (`lib/`) with `.mcpb`/`server.json`/CI ([95be5ec](https://github.com/Grinv/steam-games-mcp/commit/95be5ec)).
- Add store/keyless tools: `search_games`, `get_game`, `get_game_reviews`, `get_review_histogram`, `get_prices`, `get_specials`, `get_featured`, `get_game_news`, `get_global_achievements`, `get_current_players`, `get_wishlist` ([95be5ec](https://github.com/Grinv/steam-games-mcp/commit/95be5ec), [808c0bc](https://github.com/Grinv/steam-games-mcp/commit/808c0bc), [b4e0a10](https://github.com/Grinv/steam-games-mcp/commit/b4e0a10)).
- Add player tools (free `STEAM_API_KEY`): `resolve_vanity_url`, `get_player_summary`, `get_owned_games`, `get_recently_played`, `get_player_achievements`, `get_game_achievements` ([95be5ec](https://github.com/Grinv/steam-games-mcp/commit/95be5ec), [c31b09a](https://github.com/Grinv/steam-games-mcp/commit/c31b09a), [c663715](https://github.com/Grinv/steam-games-mcp/commit/c663715), [0239c0e](https://github.com/Grinv/steam-games-mcp/commit/0239c0e)).
- Add region/locale support via `STEAM_COUNTRY`/`STEAM_LANGUAGE`, with per-call overrides ([048f8fe](https://github.com/Grinv/steam-games-mcp/commit/048f8fe)).
