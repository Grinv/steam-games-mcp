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
  format/         # raw Steam payloads → trimmed, agent-facing shapes: storefront.ts,
                  #   web.ts (incl. keyless store services), shared.ts (generic helpers)
  lib/            # GENERIC carcass: http, rateLimit, cache, errors, logger, result
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
- **Never write to stdout** — it is the MCP protocol channel. Use the logger,
  which writes to **stderr** and redacts credentials (the Web API key travels as
  a `key` query param). The logger also mirrors each line to the MCP client as a
  `notifications/message` (the server declares the `logging` capability); that
  travels as proper JSON-RPC over the transport, not as raw stdout. To add a log
  destination, pass a `sink` to `createLogger` rather than calling `console.*`.
- Tool failures return `{ isError: true }` results (via `guard()` / `result.ts`),
  never thrown — the agent should get an actionable message.
- Keep clients fetch+cache only; all raw→agent-facing shaping lives in
  `src/format/` (`storefront.ts` / `web.ts`, generic helpers in `shared.ts`).
  Trim responses for token efficiency (cap big lists like a player's library or
  a game's achievements).
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

## Releasing

`package.json` is the **single source of truth** for the version. The npm
`version` lifecycle hook runs `scripts/sync-version.mjs`, which propagates it to
`src/version.ts`, `manifest.json` and `server.json` (incl. the `.mcpb` release-asset
URL); `version.test.ts` guards that they never drift. So a release is:

```sh
# 1. land your changes; move CHANGELOG.md's [Unreleased] notes under a new
#    [X.Y.Z] - YYYY-MM-DD heading and commit.
npm version <patch|minor|major>   # bumps + syncs every file + commits "release: vX.Y.Z" + tags vX.Y.Z
git push --follow-tags            # pushing the tag triggers .github/workflows/release.yml
```

The tag push (`v*`) runs the **Release** workflow: `check:api` gate → build → test
→ pack `.mcpb` → GitHub Release → `npm publish` (OIDC trusted publishing, with
provenance — no token) → **publish to the official MCP Registry** (`mcp-publisher`,
GitHub OIDC). Never hand-edit the version in the derived files; bump `package.json`
via `npm version` and let the hook sync the rest.

### MCP Registry

The server is listed at `registry.modelcontextprotocol.io` as
`io.github.Grinv/steam-games-mcp` (`server.json`), exposing **both** packages:
the npm package (`steam-games-mcp`, run via `npx`) and the `.mcpb` GitHub-release
bundle. Ownership is verified per package type:

- **npm** → the `mcpName` field in `package.json` must equal `server.json`'s `name`
  (guarded by `version.test.ts`). It ships in the published package, so it is
  set once and every release just works.
- **mcpb** → `server.json` needs the artifact's `fileSha256`. Because `.mcpb`
  (a zip) isn't byte-reproducible, the release workflow recomputes it from the
  just-packed bundle and injects it before `mcp-publisher publish` — the committed
  value is only a placeholder. The asset URL must contain "mcp" (it does).

The namespace `io.github.Grinv/*` is authorized by GitHub OIDC from this repo, so
no registry token/secret is needed. To publish manually instead:
`mcp-publisher login github && mcp-publisher publish`.

## Reuse / shared architecture

Generated from the **`mcp-server-template`** repository: a generic carcass
(`src/lib/` + build tooling, tests infra, CI) plus a thin domain layer
(`config.ts`, `format/`, `clients/`, domain `tools/`, `check-api.mjs`). When
fixing carcass bugs, consider whether the fix belongs upstream in the template.
