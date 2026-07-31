# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Reject a non-digit `min_discount`/`min_review` in the `deals_digest` prompt instead of interpolating a free-form value into the agent's instructions. ([8ec0dc7](https://github.com/Grinv/steam-games-mcp/commit/8ec0dc7))
- Remove the inert `allowScripts` field from `package.json`: npm has no such install-script allowlist (it is a pnpm-only feature), so it granted no supply-chain protection while implying otherwise.
- Trim repeated compat-field prose and redundant examples from the `discover_games`, `get_wishlist` and `get_recommended_games` descriptions, and note that `search_games` also returns `store_url` and `type`.

### Fixed

- Fix `discover_games` and `get_recommended_games` returning the full, unfiltered catalog for `min_discount: 100`: Steam's server-side discount filter silently no-ops at exactly 100, so a client-side discount re-check now backstops it.
- Fix `get_player_bans`'s `days_since_last_ban` reporting `0` (which reads as "banned today") for a player who has never been banned, instead of `null`.
- Fix `discover_games` `min_review: 0` excluding games that carry no review summary yet, instead of treating 0 as "no minimum".
- Fix `get_game` emitting duplicate `genres`/`categories` entries that Steam repeats in its store payload.
- Stop the retry debug log from including request query strings (which carry player `steamid`/`vanity`); it now logs the endpoint path only.
- Fix `steamid`/`other_steamid` failing on a value with stray whitespace instead of trimming it first, matching `vanity`/`STEAM_ID`. ([b97a91a](https://github.com/Grinv/steam-games-mcp/commit/b97a91a))
- Fix a 17-digit `steamid`/`other_steamid` below the individual-account base (e.g. all zeros) being sent upstream instead of rejected up front. ([b97a91a](https://github.com/Grinv/steam-games-mcp/commit/b97a91a))
- Fix `get_game_reviews`'s `positive_pct` reporting `null` instead of `0` for an all-negative game, no longer conflating 0% positive with no data. ([b97a91a](https://github.com/Grinv/steam-games-mcp/commit/b97a91a))
- Fix `get_game_achievements`'s `game` field not warning it may be Valve's internal codename (e.g. 'Fiber' for Persona 5 Royal), not the store title. ([b97a91a](https://github.com/Grinv/steam-games-mcp/commit/b97a91a))
- Fix `get_global_achievements`/`get_game_achievements` throwing on a non-numeric upstream percent instead of falling back to a safe default. ([8ec0dc7](https://github.com/Grinv/steam-games-mcp/commit/8ec0dc7))
- Fix `get_wishlist` not disclosing that its platform/Deck/OS/Machine/Frame filters also imply `include_details`, same as country/language. ([61c7ae7](https://github.com/Grinv/steam-games-mcp/commit/61c7ae7))
- Fix `get_game`'s description missing its highlighted-achievements sample (`achievements_highlighted`) from the category list. ([61c7ae7](https://github.com/Grinv/steam-games-mcp/commit/61c7ae7))
- Fix `search_games`'s description not disclosing that Steam returns only its first page of matches (~10, no pagination), so `total` is not the full catalog match count.
- Fix `get_recommended_games`'s description not naming the fixed scan sizes (30 most-played games sampled, 300-entry catalog pool) behind "can return fewer than `count`", nor its second `found:false` case (too few played games with resolvable tags).
- Disclose in `get_recommended_games`'s `min_discount` that it is re-checked client-side (so it holds at any value, including 100), matching `discover_games`.
- Note in `get_wishlist`/`get_followed_games` that `resolve_vanity_url` itself needs `STEAM_API_KEY`, even though those two tools are otherwise keyless.

## [0.12.1] - 2026-07-30

### Changed

- Reject a non-http(s) `STEAM_API_BASE_URL`/`STEAM_STORE_BASE_URL` at startup instead of accepting any URL scheme. ([6317d0e](https://github.com/Grinv/steam-games-mcp/commit/6317d0e))
- Change `get_game`'s missing-appid-and-name validation error to the SDK's generic "Input validation error: ..." wrapper instead of a bare sentence. ([6317d0e](https://github.com/Grinv/steam-games-mcp/commit/6317d0e))

### Fixed

- Fix `get_game_news` returning a misleading "resembles an injection attempt" error for a large/unassigned appid instead of a clean empty result. ([d04b623](https://github.com/Grinv/steam-games-mcp/commit/d04b623))
- Fix `search_games`'s `term` and `get_game`'s `name` accepting a whitespace-only value and running a doomed search instead of failing validation. ([2c9699a](https://github.com/Grinv/steam-games-mcp/commit/2c9699a))
- Trim a padded `search_games` `term` / `get_game` `name` before searching, instead of running the search unstripped. ([2c9699a](https://github.com/Grinv/steam-games-mcp/commit/2c9699a))
- Fix `get_game_news`'s and `get_global_achievements`'s descriptions not disclosing that an unknown appid returns an empty list, not an error. ([a91e290](https://github.com/Grinv/steam-games-mcp/commit/a91e290))
- Fix `get_items`'s description not cross-referencing `discover_games`, for finding new games by filter instead of pricing a list you already have. ([a91e290](https://github.com/Grinv/steam-games-mcp/commit/a91e290))
- Fix `get_game_achievements` not cross-referencing `get_player_achievements`, for a player's own progress instead of the catalog-wide list. ([a91e290](https://github.com/Grinv/steam-games-mcp/commit/a91e290))
- Fix `get_owned_games`'s description not cross-referencing `get_recently_played`, for the last two weeks of play instead of the all-time library. ([a91e290](https://github.com/Grinv/steam-games-mcp/commit/a91e290))
- Fix `get_game`'s `achievements_highlighted` output field missing a description of what it actually contains. ([a91e290](https://github.com/Grinv/steam-games-mcp/commit/a91e290))

## [0.12.0] - 2026-07-30

### Added

- Add a privacy policy (`PRIVACY.md`) covering data handling and caching, linked from README and manifest.json's `privacy_policies`. ([91ee519](https://github.com/Grinv/steam-games-mcp/commit/91ee519))
- Add an original gamepad icon, in Steam's own color gradient, for the MCPB/Connectors Directory submission. ([f18dc23](https://github.com/Grinv/steam-games-mcp/commit/f18dc23), [3b5d8d0](https://github.com/Grinv/steam-games-mcp/commit/3b5d8d0), [081001f](https://github.com/Grinv/steam-games-mcp/commit/081001f), [4409607](https://github.com/Grinv/steam-games-mcp/commit/4409607))

### Changed

- Raise runtime floor to Node ≥ 20.11 (was ≥ 20).

### Fixed

- Fix a 403 from a keyless Web API tool being blamed on bad credentials whenever `STEAM_API_KEY` is configured, even though it doesn't need one. ([839649d](https://github.com/Grinv/steam-games-mcp/commit/839649d), [09df3cd](https://github.com/Grinv/steam-games-mcp/commit/09df3cd))
- Fix `find_friends_who_own`'s description wrongly crediting its FULL-library comparison to `get_friend_list` instead of `get_owned_games`. ([fc003b5](https://github.com/Grinv/steam-games-mcp/commit/fc003b5))
- Fix `discover_games`/`get_wishlist`'s `tags` and `get_recommended_games`'s `exclude_tags` not disclosing that a misspelled/unrecognized tag name isn't an error — it just silently matches (or drops) nothing. ([fc003b5](https://github.com/Grinv/steam-games-mcp/commit/fc003b5))
- Fix `discover_games`'s and `get_recommended_games`'s `count` fields not stating their own max (200 and 25). ([fc003b5](https://github.com/Grinv/steam-games-mcp/commit/fc003b5))
- Fix `get_friend_list` leaking a raw 404 error for a syntactically valid but nonexistent SteamID64, instead of the graceful `found:false` every sibling tool already gives the exact same id. ([cd67c0f](https://github.com/Grinv/steam-games-mcp/commit/cd67c0f))
- Fix `is_it_worth_buying`, `what_should_i_play` and `deals_digest` not trimming whitespace-only optional arguments, defeating their blank-value fallbacks and defaults. ([e4d1160](https://github.com/Grinv/steam-games-mcp/commit/e4d1160))
- Fix `compare_players` sinking the whole call with a generic error when just one player's own library lookup hit a transient error (rate-limited/network/5xx) — the message now names which player's lookup actually failed. ([2cc0452](https://github.com/Grinv/steam-games-mcp/commit/2cc0452))
- Fix the shipped `.mcpb` bundle including dev-only files (skill docs tripled via symlinks, contributor-only docs, tooling configs) instead of just the ~9 files actually needed at runtime. ([49a9959](https://github.com/Grinv/steam-games-mcp/commit/49a9959))
- Fix README's links to dev/contributor docs excluded from the bundle (`docs/`, `AGENTS.md`, `SECURITY.md`) breaking when read from an installed extension instead of GitHub. ([37154c9](https://github.com/Grinv/steam-games-mcp/commit/37154c9))
- Fix `PRIVACY.md`/`SECURITY.md` claiming player-specific data is never cached (missing the `get_player_summary` Steam-level exception) and miscrediting cached data to `get_game_reviews` instead of the review histogram. ([93924d9](https://github.com/Grinv/steam-games-mcp/commit/93924d9))

## [0.11.0] - 2026-07-29

### Added

- Advertise a 1-hour, publicly-shareable cache hint (protocol revision 2026-07-28's `cacheHints`) for `tools/list`/`prompts/list`/`server/discover`, since the tool and prompt list never changes for the life of the process — lets a modern-era client skip re-fetching them on every reconnect. No effect on 2025-era clients.

### Changed

- Bump the MCP TypeScript SDK (`@modelcontextprotocol/{server,client,core,codemod}`) from `2.0.0-beta.5` to the `2.0.0` stable release.
- Advertise `get_player_summary`/`get_friend_list`'s `state` field as an enum of its 7 possible values in the output schema, instead of an open string. ([47989fc](https://github.com/Grinv/steam-games-mcp/commit/47989fc))
- Advertise each schema field's default value (e.g. `get_game_reviews`'s `limit`, `discover_games`'s `count`/`start`) directly in its inputSchema instead of only in prose. ([e86eb29](https://github.com/Grinv/steam-games-mcp/commit/e86eb29))

### Fixed

- Fix every tool silently dropping an unrecognized parameter name and running with defaults instead of rejecting it — every tool's input schema is now `.strict()`. ([e86eb29](https://github.com/Grinv/steam-games-mcp/commit/e86eb29))
- Fix `resolve_vanity_url`/`STEAM_ID` silently resolving to "not found" instead of the intended profile when the vanity name/SteamID carries stray whitespace (Steam's vanity lookup is an exact match). ([e86eb29](https://github.com/Grinv/steam-games-mcp/commit/e86eb29))
- Fix a padded per-call `country`/`language` override (e.g. `country: " RU "`) failing validation outright instead of being accepted like the trimmed value. ([61fe40a](https://github.com/Grinv/steam-games-mcp/commit/61fe40a))
- Fix `compare_players`/`find_friends_who_own` silently missing a played free-to-play game (e.g. Path of Exile, Warframe) instead of reporting it as owned/shared. ([465b302](https://github.com/Grinv/steam-games-mcp/commit/465b302))
- Fix HTTP 420 responses from Steam (observed live under rate limiting) being classified as a generic non-retryable error instead of the same retryable rate limit as HTTP 429. ([63e7893](https://github.com/Grinv/steam-games-mcp/commit/63e7893))
- Fix `get_recently_played` reporting `found:false` ("profile is private") for a public profile that simply hasn't played anything in the last 2 weeks. ([80dc459](https://github.com/Grinv/steam-games-mcp/commit/80dc459), fixes [#2](https://github.com/Grinv/steam-games-mcp/issues/2))

## [0.10.5] - 2026-07-28

Everything below is one commit: [37cafb8](https://github.com/Grinv/steam-games-mcp/commit/37cafb8).

### Fixed

- Fix `get_followed_games` (200-item cap), `get_wishlist`'s light default list (100-item cap), `compare_players` (top-50 cap on returned shared games) and `get_review_histogram` (24/30-entry caps) descriptions not disclosing their own fixed output caps.
- Fix `get_items`'s description not disclosing that an unknown/invalid appid comes back marked `available:false` instead of being dropped, the same behavior `get_prices`'s description already states.

## [0.10.4] - 2026-07-26

### Fixed

- Fix `get_game_achievements`/`get_global_achievements` reporting a schema-less appid (e.g. a DLC/soundtrack) as an invalid-credentials error instead of a clean empty result. ([b6a6338](https://github.com/Grinv/steam-games-mcp/commit/b6a6338))
- Fix `messageFor` echoing raw upstream error/HTML body text through a handful of error paths (`not_found`/`bad_request`/unclassified codes) instead of a clean message; harden `get_player_summary`/`get_player_bans` against a raw upstream 400 the same way every sibling player tool already was. ([b6a6338](https://github.com/Grinv/steam-games-mcp/commit/b6a6338))
- Fix `find_friends_who_own` returning unbounded `owners`/`private_friends`/`unavailable_friends` lists instead of capping them like every sibling tool. ([6a74fda](https://github.com/Grinv/steam-games-mcp/commit/6a74fda))
- Fix `discover_games`/`get_recommended_games` surfacing DLC/soundtracks alongside real games. ([f95a153](https://github.com/Grinv/steam-games-mcp/commit/f95a153))
- Fix the `what_should_i_play` prompt dropping an explicitly-given `steamid` when `tags` was also given. ([05e476f](https://github.com/Grinv/steam-games-mcp/commit/05e476f))

## [0.10.3] - 2026-07-23

### Fixed

- Fix `find_friends_who_own` failing entirely when just one friend's own library lookup hit a transient error (rate-limited/network/5xx) — that friend now lands in a new `unavailable_friends` list (with a sanitized reason) instead of sinking every other friend's results. ([6caa333](https://github.com/Grinv/steam-games-mcp/commit/6caa333))
- Fix `get_friend_list`/`find_friends_who_own` failing entirely when just one `GetPlayerSummaries` chunk (friend lists over 100) hit a transient error — the other chunks' names still come through. ([18df4ea](https://github.com/Grinv/steam-games-mcp/commit/18df4ea))
- Fix every tool's 401/403 error message blaming (or hedging about) "the credentials" even once the client already knows none were sent for that request — the message is now precise instead of guessing. ([c3a4ea7](https://github.com/Grinv/steam-games-mcp/commit/c3a4ea7), [18df4ea](https://github.com/Grinv/steam-games-mcp/commit/18df4ea))
- Fix `get_game_achievements`, `get_global_achievements` and `get_player_achievements` returning a huge achievement list (e.g. PAYDAY 2's 1,328) uncapped, blowing past the response size limit — each is now capped at 200 like their sibling tools. ([66595d9](https://github.com/Grinv/steam-games-mcp/commit/66595d9))

## [0.10.2] - 2026-07-22

Everything below is one commit: [6ead972](https://github.com/Grinv/steam-games-mcp/commit/6ead972).

### Fixed

- Fix `get_owned_games`, `get_recently_played`, `get_recommended_games`, `compare_players`, `get_friend_list`, `find_friends_who_own`, `get_wishlist` and `get_followed_games` leaking a raw upstream HTML error instead of a clean `found:false` for a handful of malformed/out-of-range SteamID64s (e.g. accountid 0) that Steam itself answers with a raw HTTP 400 for.

## [0.10.1] - 2026-07-21

### Fixed

- Fix `get_specials`/`get_featured` listing the same game twice within a section. ([877ff59](https://github.com/Grinv/steam-games-mcp/commit/877ff59))
- Fix `get_game`/`get_current_players` hiding the invalid appid behind a generic "not found" message. ([877ff59](https://github.com/Grinv/steam-games-mcp/commit/877ff59))
- Fix `get_current_players` treating Steam's 404 response for an unknown appid as a transport error instead of a clean not-found. ([877ff59](https://github.com/Grinv/steam-games-mcp/commit/877ff59))
- Fix `get_owned_games`'s `check_appids` reporting a private profile's games as `owned:false` instead of unknown. ([877ff59](https://github.com/Grinv/steam-games-mcp/commit/877ff59))

### Changed

- Clarify `discover_games`'s `total_matching`, `get_wishlist`'s count fields, `get_recommended_games`'s `match_score`, and `get_review_histogram`'s `rollup_type` — each was easy to misread. ([0521ffb](https://github.com/Grinv/steam-games-mcp/commit/0521ffb))
- Correct `discover_games`'s claim that only `min_discount` filters server-side. ([0521ffb](https://github.com/Grinv/steam-games-mcp/commit/0521ffb))
- Correct `get_player_summary`/`get_recently_played`/`get_player_achievements`'s stated privacy requirements. ([0521ffb](https://github.com/Grinv/steam-games-mcp/commit/0521ffb))
- Document `get_recommended_games`'s empty-library case and `get_friend_list`'s 100-friend cap. ([0521ffb](https://github.com/Grinv/steam-games-mcp/commit/0521ffb))
- Cross-reference `get_game_reviews`/`get_review_histogram` and disclose `get_game_reviews`'s review-text truncation. ([0521ffb](https://github.com/Grinv/steam-games-mcp/commit/0521ffb))
- Fix the `what_should_i_play` prompt instructing a non-existent `discover_games` budget filter. ([0521ffb](https://github.com/Grinv/steam-games-mcp/commit/0521ffb))

## [0.10.0] - 2026-07-21

### Added

- Advertise an `outputSchema` for every tool alongside its existing `structuredContent`, so a client can see the exact shape of a tool's result ahead of a call ([33878f5](https://github.com/Grinv/steam-games-mcp/commit/33878f5)).
- Autocomplete the `game` argument of the `is_it_worth_buying` prompt against the Steam store catalog, in clients that support live prompt-argument completion ([33878f5](https://github.com/Grinv/steam-games-mcp/commit/33878f5)).

### Changed

- Migrate to the MCP TypeScript SDK v2 (`@modelcontextprotocol/{server,client,core}`, beta) and adopt the 2026-07-28 protocol revision's `serveStdio` era negotiation ([33878f5](https://github.com/Grinv/steam-games-mcp/commit/33878f5)).

### Fixed

- Fix `get_items`/`discover_games`/`get_wishlist` misreporting a sparse-payload free game (e.g. a delisted or beta free-to-play title) as `available:false`, discarding its `is_free` status ([33878f5](https://github.com/Grinv/steam-games-mcp/commit/33878f5)).
- Fix `get_current_players` returning a misleading `player_count:null` for an unknown/invalid appid instead of an actionable not-found error ([33878f5](https://github.com/Grinv/steam-games-mcp/commit/33878f5)).
- Fix log redaction (`redact()`) missing the `apikey`/`api_key` credential-parameter spellings, only catching the bare `key` param ([33878f5](https://github.com/Grinv/steam-games-mcp/commit/33878f5)).
- Fix a whitespace-only `STEAM_API_KEY`/`STEAM_ID` env value not being treated as unset, unlike an empty string ([33878f5](https://github.com/Grinv/steam-games-mcp/commit/33878f5)).
- Fix `is_it_worth_buying`'s `game` argument failing the prompt call in MCP clients (e.g. Claude Code) that don't ask the user for a missing required prompt argument — it's optional now, and the prompt asks which game itself when omitted ([33878f5](https://github.com/Grinv/steam-games-mcp/commit/33878f5)).
- Fix `get_game`'s `demos` list dropping a real appid of `0`, mistaken for a missing appid by a falsy-value filter ([33878f5](https://github.com/Grinv/steam-games-mcp/commit/33878f5)).

### Removed

- Remove the MCP `logging` capability and `notifications/message` push, deprecated as of protocol 2026-07-28 (SEP-2577) — logs are stderr-only now, so clients that displayed them (e.g. the MCP Inspector's logging panel) no longer will; `logging/setLevel` is no longer supported ([33878f5](https://github.com/Grinv/steam-games-mcp/commit/33878f5)).

## [0.9.0] - 2026-07-18

Everything below is one commit: [99d56dc](https://github.com/Grinv/steam-games-mcp/commit/99d56dc).

### Added

- Add `get_recommended_games` — personalized picks derived from the player's own playtime-weighted tag preferences, ranked with a review-quality discount, and `exclude_tags`/`min_discount` options, excluding owned games.
- Add `check_appids` to `get_owned_games` — reliably checks the player's own ownership of specific appids against the full library, unlike the top-50-by-playtime-capped `games` list.
- Add a `vr_support` field (none/supported/required) to `get_items`, `discover_games` and `get_wishlist`'s detailed cards.

### Fixed

- Fix `get_recommended_games` treating free-to-play owned games as unowned (missing `include_played_free_games`), which could recommend a game the player already plays.
- Fix `get_recommended_games` sometimes returning far fewer than the requested `count` under a heavy `exclude_tags`/`min_discount` combination by widening its internal catalog scan (150 → 300 candidates).

### Changed

- Rename the display name to "Steam MCP Server" in `manifest.json` and `server.json` (new `title`/`websiteUrl` fields) for consistent, unambiguous branding across the .mcpb installer and MCP Registry.
- `what_should_i_play` now calls `get_recommended_games` directly when no explicit `tags` are given, instead of manually orchestrating `get_owned_games` + `get_items` + `discover_games`.
- Cross-reference `get_recommended_games`/`discover_games`, `get_owned_games`/`find_friends_who_own`, `get_recently_played`/`get_owned_games`, and `get_player_achievements`/`get_game_achievements`/`get_global_achievements` in each other's descriptions.
- Mention `get_recommended_games` in the server's MCP `instructions` and add it (plus `check_appids`) to README's tool table and example queries.

## [0.8.1] - 2026-07-18

### Changed

- Sharpen `search_games`, `get_prices`, `get_items` and `get_global_achievements`'s descriptions — cross-reference `get_items`/`get_prices` for the right batch size vs richness tradeoff, and disclose concrete parameter/return-shape facts instead of restating the schema ([d75122a](https://github.com/Grinv/steam-games-mcp/commit/d75122a), [db8c25e](https://github.com/Grinv/steam-games-mcp/commit/db8c25e), [72781e9](https://github.com/Grinv/steam-games-mcp/commit/72781e9)).

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
