# AGENTS.md

Single source of truth for working on this repository — for **any** model or
agent. `CLAUDE.md` only references this file (`@AGENTS.md`); keep all shared
guidance here, not in CLAUDE.md. (For end-user/runtime docs, see [README.md](README.md).)

## Project shape

A TypeScript MCP server for Steam. Hybrid backend, mirroring the mal-mcp/tmdb-mcp
pattern: store/game reads go through the **Steam Storefront API**
(`store.steampowered.com/api/*`) which needs **no key**, while player data
(profiles, libraries, achievements, friends) uses the **official Steam Web API**
(`api.steampowered.com`) which needs a **free key**.

> **Why two clients in one server.** The storefront gives credential-free game
> data to everyone; the Web API adds personal/player data when a key is set. A
> player tool short-circuits with a clear "set STEAM_API_KEY" message when the
> key is missing (the target profile must also be public). Keeping both in one
> server lets, e.g., a library lookup and store details compose without the agent
> threading ids between servers.

> **Keyless caveat.** Valve states _all_ Web API use requires a key
> (https://steamcommunity.com/dev), but several endpoints answer without one and
> we rely on that: `GetNewsForApp`, `GetGlobalAchievementPercentagesForApp`,
> `GetNumberOfCurrentPlayers`, `IWishlistService/GetWishlist`,
> `IStoreService/GetGamesFollowed`(+`Count`), and the store-browse services
> (`IStoreBrowseService/GetItems`, `IStoreQueryService/Query`). These tools
> are exposed without the key gate; the key is still sent when present.

> **No SteamDB, no third-party deal service.** Catalog-wide discovery
> (`discover_games` via `IStoreQueryService/Query` — deals, recency, compat, tags,
> native platform) and batch store cards (`get_items` via `IStoreBrowseService/GetItems`;
> tag names via `IStoreService/GetTagList`, enriched wishlist via
> `IWishlistService/GetWishlistSortedFiltered`) come from Steam's own keyless store
> APIs — verified live. SteamDB has no public API and
> forbids scraping (don't). **Price history is intentionally not offered**: Steam
> exposes no price-history API (confirmed against the full method list), and the
> only sources for it (SteamDB / IsThereAnyDeal) were deliberately dropped to keep
> the server Steam-only and dependency-free.

### API references

- Steam Web API: https://developer.valvesoftware.com/wiki/Steam_Web_API (official wiki);
  the machine-readable method list is `ISteamWebAPIUtil/GetSupportedAPIList` (keyless
  = the methods usable without a key).
- Store services (`IStoreBrowseService/GetItems`, `IStoreQueryService/Query`,
  `IStoreService/GetTagList`, `IWishlistService/GetWishlistSortedFiltered`) and the
  Storefront API (`store.steampowered.com/api/*`) are **unofficial/undocumented** —
  community reference at https://github.com/Revadike/InternalSteamWebAPI/wiki. All
  field shapes were verified against the live endpoints; `check:api` re-verifies on release.

```
src/
  index.ts        # bin entry — calls start()
  server.ts       # buildServer() + start(); registers everything
  config.ts       # env → validated Config (zod)
  version.ts      # VERSION/USER_AGENT, kept in sync with package.json by a test
  format/         # raw Steam payloads → trimmed, agent-facing shapes: storefront.ts,
                  #   web.ts (official Web API: player data), store.ts (keyless store
                  #   services: GetItems/Query/tags/enriched wishlist), shared.ts (helpers).
                  #   Each has a co-located *.schemas.ts (schema-first: the shaper builds
                  #   its return value via `schema.parse({...})`, see Conventions below)
  lib/            # GENERIC carcass: http, rateLimit, cache, errors, logger, result
  clients/        # storefront.ts (keyless store), web.ts (official Web API; key
                  #   optional; builds storeService.ts, exposed via `.store` for
                  #   tools/webStore.ts), storeService.ts (modern store-browse/
                  #   query/wishlist-sorted card services)
  tools/          # storefront.ts, webStore.ts (keyless-capable Web API tools),
                  #   webPlayer.ts (key-gated player tools), webShared.ts (steamid
                  #   schema + steamIdTool helper shared by the two), common.ts
                  #   (shared param schemas + reply wrapper across storefront+web),
                  #   guard.ts
  __tests__/      # node:test (*.test.ts) + helpers.ts
scripts/          # build-tests.mjs, run-tests.mjs, sync-version.mjs (generic),
                  #   check-api.mjs (domain)
skills/           # reusable agent workflows for this repo (e.g. live-audit/) —
                  #   plain Markdown, not tied to any one tool's orchestration
                  #   features. Same skill name/layout as this project's
                  #   sibling MCP servers (tmdb-mcp, mal-mcp, anilist-mcp-server)
                  #   — sync improvements both ways rather than letting them drift
```

## Commands

```sh
npm run build          # tsc --noEmit + tsup → dist/index.js (single ESM bundle)
npm test               # build tests with esbuild, run with node:test
npm run test:coverage  # same, with coverage (gate: ~80%)
npm run lint           # eslint
npm run format         # prettier --write
npm run check:api      # live upstream health-check (Storefront keyless; Web key checks skipped without STEAM_API_KEY)
npm run inspector      # run under the MCP Inspector
```

## Conventions

- **Docs and in-code text are English** (README, docs, comments, tool
  descriptions, error messages).
- Runtime floor is **Node ≥ 20** (global `fetch`, stable `node:test`); tsup
  targets `node20`.
- **Never write to stdout** — it is the MCP protocol channel. Use the logger,
  which writes to **stderr only** and redacts credentials (the Web API key
  travels as a `key` query param). There is no MCP `logging` capability and no
  `notifications/message` mirroring (removed per SEP-2577 / protocol
  2026-07-28 — see `src/server.ts`'s comment on `serveStdio`). To add a log
  destination, pass a `sink` to `createLogger` rather than calling `console.*`.
- Tool failures return `{ isError: true }` results (via `guard()` / `result.ts`),
  never thrown — the agent should get an actionable message.
- Keep clients fetch+cache only; all raw→agent-facing shaping lives in
  `src/format/` (`storefront.ts` / `web.ts` / `store.ts`, generic helpers in
  `shared.ts`). Every exported summarizer builds its return value via its
  co-located schema's `schema.parse({...})` (schema-first: the schema is the
  single source of truth, so the shaper and its `outputSchema` can't drift
  apart) — `.parse()` calls and schema imports belong only in `format/`, never
  in `clients/`. Trim responses for token efficiency (cap big lists like a
  player's library, a game's achievements, or a friend list).
- Use `describe()`/`test()` nesting in `src/__tests__/` whenever 2+ tests share
  a subject; a flat list of `test()` calls is fine for single-subject files.
- Write tool `description`s and per-field `.describe()` text for the calling
  model: explain when to use a tool and what each parameter means. Check new
  or edited descriptions against [docs/tool-descriptions.md](docs/tool-descriptions.md)
  (Glama's TDQS rubric) before committing.
- Keep dependencies minimal. New deps need a clear justification (supply-chain).
- **Never commit secrets.** The key comes from env vars / OS keychain only.
- Cross-platform: macOS, Linux and Windows. Avoid POSIX-only shell in npm
  scripts (use the Node helper scripts).
- **Commits:** author/committer `Grinv <4070730+Grinv@users.noreply.github.com>`;
  do **not** add a `Co-Authored-By` trailer.
- **CodeQL** (`.github/workflows/codeql.yml`) scans `javascript-typescript` on
  push/PR to main plus a weekly cron — no local equivalent command; findings
  surface under the repo's **Security → Code scanning** tab.

## Testing the live/published server

For a full audit of the currently published (or just-fixed) package —
build/test/lint plus hammering the live MCP tools with edge cases,
cross-checked against source — follow
[skills/live-audit/SKILL.md](skills/live-audit/SKILL.md). It covers the
keyless-vs-key-gated tool split, SteamID64/appid edge cases, and known bug
classes found in past passes worth checking don't recur. For a diff that
touches error-handling or partial-failure resilience specifically (a new
`Promise.allSettled`/try-catch), also run `/code-review` (or an equivalent
static-reasoning pass) over it — live-testing structurally can't trigger one
specific sub-request's failure on cue, so bugs in that exact path (an
unsanitized error message, an outer `Promise.all` quietly defeating the fix)
need the code read, not called.

## Before opening a PR

Run `npm run build && npm test && npm run lint && npm run format:check`.
Update `CHANGELOG.md` (Unreleased section) — see
[docs/changelog-style.md](docs/changelog-style.md) for entry style.

## Releasing

`package.json` is the single source of truth for the version; `npm version`
bumps + syncs every derived file + tags the release. See
[docs/releasing.md](docs/releasing.md) for the full steps and MCP Registry details.

## Notes

Personal/scratch notes (not load-bearing) live in
[docs/notes.md](docs/notes.md).

## Reuse / shared architecture

Generated from the **`mcp-server-template`** repository: a generic carcass
(`src/lib/` + build tooling, tests infra, CI) plus a thin domain layer
(`config.ts`, `format/`, `clients/`, domain `tools/`, `check-api.mjs`). When
fixing carcass bugs, consider whether the fix belongs upstream in the template.
