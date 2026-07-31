# AGENTS.md

Single source of truth for working on this repository — for **any** model or
agent. `CLAUDE.md` only references this file (`@AGENTS.md`); keep all shared
guidance here, not in CLAUDE.md. (For end-user/runtime docs, see [README.md](README.md).)

## Project shape

A TypeScript MCP server for Steam. Hybrid backend, mirroring the mal-mcp/tmdb-mcp
pattern: store/game reads go through the **Steam Storefront API**
(`store.steampowered.com/api/*`) which needs **no key**, while player data
(profiles, libraries, achievements, friends) uses the **official Steam Web API**
(`api.steampowered.com`) which needs a **free key**. Design rationale (why two
clients, the keyless caveat, why no SteamDB/price-history, API references,
template reuse) lives in [docs/architecture.md](docs/architecture.md).

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
                  #   schema, steamIdTool helper and requireKey, shared by the two),
                  #   common.ts (shared param schemas, toCompatFilters + reply
                  #   wrapper across storefront+web), guard.ts, prompts.ts (MCP
                  #   Prompts)
  __tests__/      # node:test (*.test.ts) + helpers.ts
scripts/          # build-tests.mjs, run-tests.mjs, sync-version.mjs (generic),
                  #   check-api.mjs (domain), preversion-check.mjs (CHANGELOG gate)
skills/           # reusable agent workflows for this repo (e.g. live-audit/) —
                  #   plain Markdown with a YAML frontmatter name/description,
                  #   not tied to any one tool's orchestration features. Same
                  #   skill name/layout as this project's sibling MCP servers
                  #   (tmdb-mcp, mal-mcp, anilist-mcp-server) — sync
                  #   improvements both ways rather than letting them drift.
                  #   `.claude/skills`/`.agents/skills` are symlinks to this
                  #   directory (Claude Code/Codex CLI/Gemini CLI pickup)
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
  descriptions, error messages) — and so is everything posted to a public/shared
  surface (commit messages, GitHub issue/PR comments and bodies), regardless of
  what language the working conversation happens to be in.
- Runtime floor is **Node ≥ 20.11** (global `fetch`, stable `node:test`,
  `context.mock.timers` used throughout `__tests__/`, `AbortSignal.any()` in
  `lib/http.ts`, and `import.meta.dirname` in the `scripts/*.mjs` helpers —
  need 20.4+/20.3+/20.11+ respectively, so `>=20` alone would understate the
  real requirement); tsup targets `node20` (esbuild's Node targets are
  major-version-only, so this doesn't need to track the patch floor). `.nvmrc`
  pins the maintainer's local dev version (currently `22`) for convenience, not
  the supported floor — CI's `node: [20, 22, 24]` matrix is what actually
  enforces `>=20.11`.
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
- **Never use `z.date()`/`z.bigint()`/`z.nan()`/`.transform()`/`z.map()`/`z.set()`
  in a tool's `inputSchema`/`outputSchema`.** The SDK converts every registered
  schema via zod's native `z.toJSONSchema()` with its default
  `unrepresentable: "throw"` (see `node_modules/@modelcontextprotocol/server/
dist/src-*.mjs`'s `standardSchemaToJsonSchema`) — one of these types reaching
  a tool schema throws at registration time, not a degraded-but-working JSON
  Schema. Dates from Steam already arrive as display strings (e.g. `release_date`),
  so plain `z.string()` is correct there anyway, not a workaround.
- Use `describe()`/`test()` nesting in `src/__tests__/` whenever 2+ tests share
  a subject; a flat list of `test()` calls is fine for single-subject files.
- Write tool `description`s and per-field `.describe()` text for the calling
  model: explain when to use a tool and what each parameter means. Check new
  or edited descriptions against the `tool-description-check` skill (Glama's
  TDQS rubric) before committing.
- **Name a field for what it actually accepts, not a generic ID suffix** —
  e.g. `steamid` (a 17-digit SteamID64 only) rather than a generic
  `user_id`/`id`, with the vanity/custom-profile-name case handled by its
  own separate `vanity` field (resolved to a `steamid` via
  `resolve_vanity_url`), and `get_game`'s `appid`/`name` kept as two
  distinct optional fields instead of one overloaded `id`. Keep the same
  field name for the same concept across every tool that takes it — grep
  sibling tools before naming a new field for an existing concept (`steamid`
  is one shared schema exported from `tools/webShared.ts`, not redeclared
  per tool).
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
Update `CHANGELOG.md` (Unreleased section) — see the `changelog-style` skill for
entry style.

## Releasing

`package.json` is the single source of truth for the version; `npm version`
bumps + syncs every derived file + tags the release. See the `release` skill
for the full steps (including the `preversion` gate on `CHANGELOG.md` and
tool descriptions) and MCP Registry details.

## Notes

Personal/scratch notes (not load-bearing) live in
[docs/notes.md](docs/notes.md).
