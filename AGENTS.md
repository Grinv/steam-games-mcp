# AGENTS.md

Single source of truth for working on this repository — for **any** model or
agent. `CLAUDE.md` only references this file (`@AGENTS.md`); keep all shared
guidance here, not in CLAUDE.md. (For end-user/runtime docs, see [README.md](README.md).)

## Project shape

A TypeScript MCP server for Steam. Hybrid backend, mirroring the mal-mcp/tmdb-mcp
pattern: store/game reads go through the **Steam Storefront API**
(`store.steampowered.com/api/*`) which needs **no key**, while player data
(profiles, libraries, achievements) uses the **official Steam Web API**
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
> `GetNumberOfCurrentPlayers`, `IWishlistService/GetWishlist`, and the store-browse
> services (`IStoreBrowseService/GetItems`, `IStoreQueryService/Query`). These tools
> are exposed without the key gate; the key is still sent when present.

> **No SteamDB, no third-party deal service.** Catalog-wide deal discovery
> (`discover_deals` via `IStoreQueryService/Query` with `price_filters.min_discount_percent`)
> and batch price+review (`get_items` via `IStoreBrowseService/GetItems`) come from
> Steam's own keyless store APIs — verified live. SteamDB has no public API and
> forbids scraping (don't). **Price history is intentionally not offered**: Steam
> exposes no price-history API (confirmed against the full method list), and the
> only sources for it (SteamDB / IsThereAnyDeal) were deliberately dropped to keep
> the server Steam-only and dependency-free.

### API references

- Steam Web API: https://developer.valvesoftware.com/wiki/Steam_Web_API (official wiki);
  the machine-readable method list is `ISteamWebAPIUtil/GetSupportedAPIList` (keyless
  = the methods usable without a key).
- Store services (`IStoreBrowseService/GetItems`, `IStoreQueryService/Query`) and the
  Storefront API (`store.steampowered.com/api/*`) are **unofficial/undocumented** —
  community reference at https://github.com/Revadike/InternalSteamWebAPI/wiki. All
  field shapes were verified against the live endpoints; `check:api` re-verifies on release.

```
src/
  index.ts        # bin entry — calls start()
  server.ts       # buildServer() + start(); registers everything
  config.ts       # env → validated Config (zod)
  format.ts       # raw Steam payloads → trimmed, agent-facing shapes
  lib/            # GENERIC carcass: http, rateLimit, cache, errors, logger, result, tokenStore
  clients/        # storefront.ts (keyless store), web.ts (Web API; key optional)
  tools/          # storefront.ts, web.ts (player tools gated on the key), guard.ts
  __tests__/      # node:test (*.test.ts) + helpers.ts
scripts/          # build-tests.mjs, run-tests.mjs (generic), check-api.mjs (domain)
```

## Commands

```sh
npm run build          # tsc --noEmit + tsup → dist/index.js (single ESM bundle)
npm test               # build tests with esbuild, run with node:test
npm run test:coverage  # same, with coverage (gate: ~80%)
npm run lint           # eslint
npm run format         # prettier --write
npm run check:api      # live upstream health-check (Storefront keyless; Web key check skipped without STEAM_API_KEY)
npm run inspector      # run under the MCP Inspector
```

## Conventions

- **Docs and in-code text are English** (README, docs, comments, tool
  descriptions, error messages).
- Runtime floor is **Node ≥ 18** (global `fetch`); tsup targets `node18`.
- Log to **stderr only** — stdout is the MCP protocol channel. Use the logger;
  it redacts credentials (the Web API key travels as a `key` query param).
- Tool failures return `{ isError: true }` results (via `guard()` / `result.ts`),
  never thrown — the agent should get an actionable message.
- Keep clients fetch+cache only; all raw→agent-facing shaping lives in
  `src/format.ts`. Trim responses for token efficiency (cap big lists like a
  player's library or a game's achievements).
- Write tool `description`s and per-field `.describe()` text for the calling
  model: explain when to use a tool and what each parameter means.
- Keep dependencies minimal. New deps need a clear justification (supply-chain).
- **Never commit secrets.** The key comes from env vars / OS keychain only.
- Cross-platform: macOS, Linux and Windows. Avoid POSIX-only shell in npm
  scripts (use the Node helper scripts).
- **Commits:** author/committer `Grinv <4070730+Grinv@users.noreply.github.com>`;
  do **not** add a `Co-Authored-By` trailer.

## Before opening a PR

Run `npm run build && npm test && npm run lint && npm run format:check`.
Update `CHANGELOG.md` (Unreleased section).

## Reuse / shared architecture

Generated from the **`mcp-server-template`** repository: a generic carcass
(`src/lib/` + build tooling, tests infra, CI) plus a thin domain layer
(`config.ts`, `format.ts`, `clients/`, domain `tools/`, `check-api.mjs`). When
fixing carcass bugs, consider whether the fix belongs upstream in the template.
