# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-07-16

### Changed

- Runtime floor raised to Node ≥ 20 (was ≥ 18).

### Added

- `steam_machine` compat field/filter — `get_items`, `discover_games` and
  `get_wishlist` now distinguish Steam Machine support from general `steam_os`.
- `get_followed_games` tool — a player's Steam store follows list (keyless).
- `get_player_bans` tool — VAC/game/community/economy ban status.
- `get_player_summary` now also returns Steam level.

### Fixed

- `get_followed_games` no longer errors out if just the count lookup fails.
- `build-tests.mjs` clears `dist-tests/` before rebuilding, so deleted/renamed
  test files can't leave stale compiled copies behind.
- Fixed a `RateLimiter` edge case that could misfire under a clock near the
  epoch.

### Internal

- Split the grown `clients/web.ts` / `tools/web.ts` into smaller per-concern
  files.
- Split `steam.test.ts` into per-domain test files with shared fixtures.
- Tests now use `t.mock` / `t.after` (Node 20's stable `node:test` APIs)
  instead of manual restore/`finally` boilerplate.
- Integration tests are grouped into `describe()` blocks per tool.

## [0.6.0] - 2026-07-12

### Added

- `get_friend_list` tool — a player's Steam friends (name, online state, current
  game, friends-since), enriched via `GetPlayerSummaries`. Requires `STEAM_API_KEY`
  and a public friends list.
- `find_friends_who_own` tool — which of a player's friends own given appid(s)
  and how many hours they've played, checked against each friend's FULL
  owned-games list (unlike `get_owned_games` / `get_friend_list`, never capped
  to the top 50 by playtime). Friends with a private library are reported
  separately, not counted as non-owners.

### Fixed

- `get_wishlist` (`include_details`): Steam's `GetWishlistSortedFiltered` only
  attaches store data to roughly the first 100 entries of a wishlist, no matter
  what pagination params are sent (verified live) — on a bigger wishlist,
  filters were silently only checking that prefix while the tool description
  claimed the whole wishlist was covered. The response now reports `enriched`
  (how many entries actually got store data) alongside `total`, with a `note`
  explaining the gap when Steam truncates it.

## [0.5.0] - 2026-07-09

Richer store cards and catalog/wishlist discovery for the SteamOS / Steam Machine
era: three hardware-compatibility ratings, native-platform and user-tag filters,
a one-call enriched wishlist, discount expiry and clickable store links — all
keyless. Plus a substantial DRY/KISS refactor of the store-service layer.

### Added

- **SteamOS and Steam Frame compatibility.** Valve's store API now returns two
  compatibility ratings alongside `steam_deck_compat_category`:
  `steam_os_compat_category` (SteamOS in general — any SteamOS device, including
  the new Steam Machine, not just it) and `steam_frame_compat_category` (the Steam
  Frame VR headset). `get_items` and `discover_games` now surface both as
  `steam_os` / `steam_frame` (same `verified`/`playable`/`unsupported`/`unknown`
  scale as `steam_deck`), and `discover_games` gains matching `steam_os` /
  `steam_frame` filters. So "games that run on the Steam Machine / SteamOS" and
  "Frame-Verified VR games" are now answerable.
- **Popular user tags.** `get_items` and `discover_games` now surface each game's
  top user tags (e.g. `Roguelike`, `Souls-like`, `Deckbuilding`) as readable
  names — resolved keyless from Steam's tag dictionary
  (`IStoreService/GetTagList`, cached per language). `discover_games` also gains a
  `tags` filter (AND, case-insensitive), so "roguelike deckbuilders on sale" is a
  single call. Like the other `discover_games` filters it runs over the
  popularity-first scan window (Steam's catalog API silently ignores tag filters),
  so raise `count` when combining niche tags.
- **Native-platform (`platform`) filter + `platforms` field.** Store cards
  (`get_items`, `discover_games`, `get_wishlist` detailed) now list each game's
  native OS builds as `platforms` (`windows`/`mac`/`linux`), and `discover_games` /
  `get_wishlist` gain a `platform` filter to keep only games with a native build
  for that OS. Note: `linux` means a native Linux/SteamOS build — distinct from
  `steam_os` (SteamOS Proton compatibility), which is a separate filter.
- **Enriched, filterable wishlist in one call.** `get_wishlist` gains
  `include_details` — full store cards per item (name, price/discount, review %,
  Deck/SteamOS/Frame compat, tags, release) via
  `IWishlistService/GetWishlistSortedFiltered`, so "my wishlist with prices" no
  longer needs a follow-up `get_items`. Narrow it in the same call with `tags`,
  `platform` (native build), `steam_deck` / `steam_os` / `steam_frame` (Proton
  compatibility), `min_review` and `min_discount` / `on_sale_only` (e.g. "top
  metroidvanias on my wishlist, on sale, well-reviewed, that run on SteamOS") —
  filters run over the whole wishlist before the output cap, and `matched` reports
  the pre-cap count. The default (no flags) still returns the light appid list.
- **`discount_end` — when a deal expires.** Store cards (`get_items`,
  `discover_games`, `get_wishlist` detailed) now include `discount_end` (ISO 8601
  UTC) for discounted games, so "how long is this discount valid?" is answerable
  and "deals ending soon" is sortable. Sourced from the store service's
  `active_discounts`; the Storefront-backed `get_game` / `get_prices` don't carry
  it.
- **Clickable `store_url` on every card.** `get_items`, `discover_games` and
  `get_wishlist` (both light and detailed) now include a `store_url` linking
  straight to each game's Steam store page — so results are one click away from the
  page (the storefront tools already carried it; the store-service tools didn't).

### Fixed

- **A failed tag lookup no longer masquerades as "no games matched."** If
  Steam's tag dictionary (`IStoreService/GetTagList`) is temporarily
  unavailable, `discover_games` and `get_wishlist`'s `tags` filter used to
  silently return zero results (an empty dictionary made every tag comparison
  fail) with no indication anything was wrong. Both now return a clear,
  actionable error instead when a `tags` filter can't be reliably applied;
  tag _display_ (no filter requested) still degrades gracefully to an empty
  `tags` list, unaffected.
- **`get_wishlist`'s `country`/`language` no longer silently no-op.** Passing
  either without any other filter used to fall through to the light,
  appid-only response, which carries no price and therefore ignored both
  parameters. Setting `country` or `language` now switches to the detailed
  (store-card) view, same as any other filter.
- **`check:api` now also verifies `IWishlistService/GetWishlistSortedFiltered`**,
  the endpoint backing `get_wishlist`'s `include_details`/filters — previously
  the only new store service from this release without a live release-gate check.

### Internal

- **Refactored the grown store-service layer (DRY/KISS), no behaviour change.**
  Split the 660-line `format/web.ts` into `format/web.ts` (official Web API / player
  data) and `format/store.ts` (keyless store services); extracted a shared
  `baseCard` so `get_items` and `discover_games`/wishlist cards stop duplicating ~10
  fields (and `get_items` now also carries the native `platforms` list);
  centralised the tool param schemas + `reply()` wrapper in `tools/common.ts`
  (killing duplicate `READ_ONLY`/`appid`/`country`/`language`/compat defs across the
  two registration files); folded the repeated client `data_request` block into one
  helper; and unified the client-side filtering (compat / native platform / tags /
  review / discount / recency) that `discover_games` and the wishlist detailed view
  both apply into a single `storeItemFilter` predicate. A second pass over the
  storefront layer: shared `formattedPrice` / `storeUrl` helpers (dropped a stray
  inline URL), a `#search` helper behind `searchGames`/`resolveAppId`, and — since
  `getFeatured` and `getSpecials` hit the same endpoint — caching the raw
  `featuredcategories` payload once so the two share a single upstream call per
  region. A follow-up pass extracted `priceFields` so `get_items`'s nested price
  block and the other cards' flat one share one `discount_pct`/`discount_end`/
  original-price-fallback derivation instead of two hand-written copies.
- **`TtlCache` now shares one in-flight fetch across concurrent callers of the
  same key**, instead of each starting its own. This mattered in practice once
  `get_items`/`discover_games`/`get_wishlist` all began fetching the same
  `tags:${language}` tag-dictionary cache key: two of those tools called at once
  on a cold cache used to trigger two redundant `GetTagList` requests against the
  keyless, rate-limited endpoint; now the second call reuses the first's promise.
- **Expanded test coverage** to ~94% lines (112 tests): direct unit tests for the
  store card builders and `discountEnd`, the shared `storeItemFilter` (one case per
  filter dimension), the new cache in-flight dedup, sparse-/malformed-payload
  fallbacks in the storefront and Web API formatters, and regressions for the
  `tags`-filter/`country`-`language` fixes above. Added `check:api` guards for
  the compat + tag fields and the `GetTagList` dictionary (see also the
  `GetWishlistSortedFiltered` guard under Fixed).
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

### Dependencies

- Dev-dependency bumps: `@types/node` 26.1.1, `prettier` 3.9.4,
  `typescript-eslint` 8.63.0. (TypeScript 7 deferred — `typescript-eslint` isn't
  compatible with it yet.)

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
