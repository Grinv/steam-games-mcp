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
                  #   web.ts + webAchievements.ts (official Web API: player data /
                  #   achievement lists), store.ts (keyless store-service summarizers:
                  #   SearchSuggestions/GetItems/Query/wishlist/recommendations) over
                  #   storeCard.ts (their
                  #   shared StoreItem/tag/compat/card/filter toolkit), shared.ts (helpers),
                  #   charts.ts (keyless chart services: top sellers / most played /
                  #   Steam Deck most played / live concurrent players, for get_charts).
                  #   Each shaper has a co-located *.schemas.ts (schema-first: the shaper
                  #   builds its return value via `schema.parse({...})`, see Conventions);
                  #   storeCard.ts shares store.schemas.ts with store.ts
  lib/            # GENERIC carcass: http, rateLimit, cache, concurrency, errors,
                  #   logger, result, endpoint (the Endpoint shape and call()),
                  #   call (the tool call's scope: cancellation,
                  #   optional()/optionalParts()/orFailure(), CallCancelled)
  clients/        # endpoints.ts (every Steam endpoint and what its answers
                  #   mean, with live probes — see "What Steam means"),
                  #   storefront.ts (keyless store; takes storeService as a
                  #   PurchasePriceSource, because Storefront prices are wrong —
                  #   see docs/architecture.md), web.ts (official Web API; key
                  #   optional; builds storeService.ts, exposed via `.store` for
                  #   tools/webStore.ts; also the one place that talks to
                  #   steamcommunity.com, to resolve a vanity STEAM_ID without a
                  #   key), storeService.ts (modern store-browse/
                  #   query/wishlist-sorted card services)
  tools/          # storefront.ts, webStore.ts (keyless-capable Web API tools),
                  #   webPlayer.ts (key-gated player tools), webShared.ts (steamid
                  #   schema, steamIdTool helper and keyGate, shared by the two),
                  #   common.ts (shared param schemas, toCompatFilters across
                  #   storefront+web), guard.ts (toolOutput: the guard/reply
                  #   wrappers, built per server with its logger; toolRegistrar:
                  #   the tool() every tool registers through), prompts.ts
                  #   (MCP Prompts)
  __tests__/      # node:test (*.test.ts) + helpers.ts
scripts/          # run-tests.ts, sync-version.ts (generic), check-api.ts
                  #   (domain), preversion-check.ts (CHANGELOG gate) — plain
                  #   .ts run directly by Node's type stripping, no build step
.agents/skills/   # reusable agent workflows for this repo (e.g. live-audit/) —
                  #   plain Markdown with a YAML frontmatter name/description,
                  #   not tied to any one tool's orchestration features. Same
                  #   skill name/layout as this project's sibling MCP servers
                  #   (tmdb-mcp, mal-mcp, anilist-mcp-server) — sync
                  #   improvements both ways rather than letting them drift.
                  #   `.claude/skills` is a symlink here (Codex CLI/Gemini CLI
                  #   read `.agents/skills` directly, Claude Code the symlink)
```

## Commands

```sh
npm run build          # tsc --noEmit + tsdown → dist/index.js (single ESM bundle)
npm test               # node:test straight on src/**/*.test.ts (native type stripping, no build)
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
- Runtime floor is **Node ≥ 22.18** — the first 22.x where type stripping is
  on by default (and warning-free), which is what lets `npm test` and every
  `scripts/*.ts` run as plain `.ts` with no build step; tsdown needs it too.
  The range stays open-ended (`>=22.18.0`) because it guards the _runtime_
  bundle, which needs nothing newer. For development use 22.18+, 24.11+ or
  26+: Node 23.0–23.5 has no default type stripping, and tsdown's own engines
  skip 23.x and 24.0–24.10.
  Declared in both `package.json` `engines` and `manifest.json`
  `compatibility.runtimes.node` — a test keeps them equal. Because Node only
  _strips_ types, `tsconfig.json` sets `erasableSyntaxOnly` (no enums,
  namespaces or parameter properties) and `allowImportingTsExtensions`
  (relative imports use `.ts`, not `.js`). **No `using`/`await using`** —
  esbuild used to downlevel it for tests, but Node 22's V8 12.4 can't parse
  it; register cleanup with `t.after()` instead. tsdown reads its target
  from `engines.node` (`node22.18.0`); `tsconfig.json` targets `ES2024` plus only the
  ES2025 libs V8 12.4 ships (`ES2025.Collection` Set methods,
  `ES2025.Iterator` helpers) — not full `ES2025`, whose `Promise.try`,
  `RegExp.escape` and `Float16Array` need Node 24. `.nvmrc` pins the
  maintainer's local dev version (currently `22`) for convenience, not the
  supported floor — CI's `node: ["22.18", 22, 24, 26]` matrix is what actually
  enforces `>=22.18` (the pinned `22.18` job tests the exact floor, not just the
  latest 22.x). Note `@types/node` tracks current Node, not the floor, so `tsc`
  will happily accept an API that only exists past 22.18; that CI job is the
  only thing that catches it.
- `tsc` (`npm run typecheck`, part of `npm run build`) also covers
  `scripts/`, `tsdown.config.ts` and `eslint.config.js` — the latter via
  `allowJs`/`checkJs` plus ESLint's typed `defineConfig()` — so a config typo
  (unknown key, misspelled severity or preset) fails the build. Rule _options_
  stay untyped (`unknown[]`); `eslint` itself validates those at run time.
- **Never write to stdout** — it is the MCP protocol channel. Use the logger,
  which writes to **stderr only** and redacts credentials (the Web API key
  travels as a `key` query param). There is no MCP `logging` capability and no
  `notifications/message` mirroring (removed per SEP-2577 / protocol
  2026-07-28 — see `src/server.ts`'s comment on `serveStdio`). To add a log
  destination, pass a `sink` to `createLogger` rather than calling `console.*`.
- Tool failures return `{ isError: true }` results, never thrown — the agent
  should get an actionable message. One pipeline, three layers
  ([docs/errors.md](docs/errors.md) is the user-facing side):
  - **Classify** where a failure is detected: an `ApiError` whose `code` says
    what happened (never picked for how it renders). `message` is diagnostics
    for the log (it may hold Steam's raw HTML body); agent-facing specifics go
    in `detail` and are always our own text. A domain error explaining an
    upstream failure keeps that failure's `code`/`status`/`retryable` and
    wraps it as `cause`. Facts true of every Steam endpoint are classified
    once, at the source: a bad key is `invalid_key` (in `SteamWebClient`'s `classify`),
    and "is this transient" is only ever `err.retryable` — never a code list
    re-derived at a call site. A client method maps only its own endpoint's
    quirks (e.g. GetFriendList's 401 = private), and only by `code`.
  - **Exactly one place turns a non-`ApiError` into an `ApiError`**:
    `HttpClient#once`, for `fetch`'s own rejection (network/timeout).
    Everywhere else — a retry loop, a `validate`/`check` hook, a cache
    fallback — a non-`ApiError` is a bug and propagates unchanged; widening a
    `try` around new code must not route that code's bugs into a catch that
    retries, degrades or answers from cache.
  - **Translate** in one place, `toProblem()` in `lib/result.ts`: an RFC 9457
    problem built from `code`/`status`/`detail` via a `Record` table (a new
    code without an entry doesn't compile). Anything that isn't an `ApiError`
    is a bug — logged with stack and cause chain, shown to the agent as a
    stable "internal error".
  - **Output** only through the `tool(name, config, handler, { gate })`
    registrar (`toolRegistrar` in `tools/guard.ts`): a handler just returns
    its structured data; `reply` (errors, notes, the call's `ctx`), the
    outputSchema's `notes` and an optional `gate` (e.g. `keyGate`: no key
    configured) are wired there once, for every tool. The model reads
    `detail` as the result text, the Problem rides in
    `_meta["io.github.Grinv/problem"]`. Prompt completions, the one path
    outside it, follow the same rule: an upstream failure degrades quietly,
    a bug is logged. A partial failure inside a successful result (e.g.
    `find_friends_who_own`'s per-friend reason) is worded by
    `problemDetail()` in the formatter.
- **What Steam means is stated once per endpoint**, in `clients/endpoints.ts`
  (`lib/endpoint.ts` defines the shape): path, host, keyless or not, the plain
  answers Steam sends as HTTP errors (`answers`: e.g. GetFriendList's 401 →
  "not_shown"), and the body rule (`validate`). A client
  calls through `call(...)`/`#call(...)` and gets data, or `{ answer }` typed
  by the endpoint, so the compiler makes it handle every answer — there is no
  `catch` reading Steam in a client. Each stated fact has `probes`: live calls
  that show it, run by `npm run check:api`. Add a fact only with a probe that
  passes against live Steam today — a fact from memory is how the bad-key 401
  went unclassified while every test passed on a 403 fixture. **A code means
  what it was seen to mean, never more:** each `answers` entry must be backed
  by a recorded situation producing that code (`recorded.test.ts` enforces
  it), so a guess about what else a status might mean — "a 403 under load",
  "an empty answer is a hiccup" — has nowhere to go. There used to be such
  a mechanism (`ambiguous`, exempt from probes); every entry in it turned
  out to be unobserved (the rarity "403 under load" was Steam's 420 misread),
  and the code built on it drew three review rounds of bugs.
  **What Steam sends in a situation is recorded, never written by hand.** A
  probe that isn't a plain success names its `situation`; check:api's
  `--record` flag saves Steam's real response (status, body) to
  `src/__tests__/recorded/steam.json`, tests replay it with
  `recorded("<Endpoint>/<situation>")`, and a plain `check:api` fails when
  Steam's status for one has moved. `recorded.test.ts` keeps probes and
  recordings one set. Hand-written error bodies stay only in tests of the
  generic pipeline (`lib/` behaviour on any status), never as "what Steam
  answers here": that is how the 403 fixture above, a bad key "401 on all of
  IPlayerService" (only GetOwnedGames is) and an invented accountid-0 page
  went unnoticed.
- **Decide from the fact, at the place it is known — never from a stand-in
  for it.** Every bug in the error/cache rework's review rounds was one
  decision taken from a proxy: advice picked by "was a key sent" instead of
  the classified code; "is this fetch failing" by what sat inside a `try`;
  a bad key read from the truncated log `message` instead of the body; a
  body rule passed per call to a cache keyed by URL; two gaps merged because
  their note text matched; "no reviews" read off a falsy count. So: classify
  from Steam's response itself (status, body) in `classify`/`endpoints.ts`;
  state a rule where its identity lives (a body rule on the Endpoint, whose
  query is the URL); never read `ApiError.message` for a decision (it is log
  text); never let a rendered string stand for identity (dedupe, count or
  key by the data, not its wording).
- **Tell the agent what Steam returned, not a cause it didn't give.** Steam
  answers alike for situations it doesn't tell apart: GetPlayerAchievements'
  403 "Profile is not public" comes for a private profile, private game
  details, an account that doesn't exist and a game a public player doesn't
  own. A `found:false` reason states what wasn't returned and which tool
  establishes why (`notShown()` in `format/shared.ts`); a cause is stated
  only when the server established it (the schema says a game has no
  achievements; GetPlayerSummaries' empty list says no account exists).
- **A tool's answer is a required core plus optional parts** (a price
  correction, rarity, a Steam level, names, tags). A required part is a plain
  `await`: its failure is the tool's error. An optional one goes through
  `optional(what, promise)` (`lib/call.ts`), or `optionalParts(settled, what)`
  for the chunks of a batch: Steam failing becomes `undefined` plus a note,
  a bug or the call's cancellation still propagates. Never a hand-written
  `try/catch` that degrades; every `allSettled`/`catch` around a Steam call is
  either that, `orFailure()` (a Steam failure as a value, for a caller that
  decides per use — e.g. the tag dictionary, fatal to a filter, optional on a
  card), or the endpoint's declared `answers`. ESLint enforces it: no `catch`
  in `src/clients/`, no schemas or `lib/result.ts` there (a client words only
  an `ApiError`'s `detail`, where it classifies), and no fetching
  or transport in `src/format/` (`eslint.config.js`). A formatter renders `undefined` as unknown (`null`/empty),
  never as a negative fact. `guard` turns the call's notes (and any stale
  fallback) into `structuredContent.notes` — the only place the model looks
  (verified: Claude Code feeds it structuredContent alone, not other content
  blocks or `_meta`) — logs them at `warn`, and every outputSchema carries
  the optional field via `withNotes`. `degradation.test.ts` fails every tool's
  every endpoint in turn and requires an error or a note, never silence.
- **Caching is per request**, in `HttpClient` (`getJson(..., { cache: true })`,
  `lib/cache.ts`): one entry is one Steam response body, keyed by URL, so
  shaping and combining requests always run after the cache and a partial
  answer is never stored as a whole one. `getJson<T>` returns a JSON object or
  fails: an empty body, `null` or any non-object is `bad_response` (retryable),
  never data a caller would dereference. Two hooks run before the cache, so it acts
  on what actually happened: the host client's `classify` (Steam's bad-key page →
  `invalid_key`) and the endpoint's `validate` (a body it can't use, e.g. an
  empty tag dictionary, fails like a request and is never cached). A stale copy answers only a
  `retryable` failure, without retries when one exists; it is collected per call via
  `callScope` and flags `_meta["io.github.Grinv/stale"]`. `_meta` keys use `META_PREFIX`
  (`src/version.ts`), the reverse-DNS namespace of `mcpName`.
- **Cancellation** reaches Steam without being threaded through clients: the
  `tool()` registrar passes the SDK's `ctx` to `reply`/`guard`, which run the call
  inside `callScope` (`lib/call.ts`, an `AsyncLocalStorage`) with
  `ctx.mcpReq.signal`. `HttpClient` aborts the rate-limit wait (queued or
  spacing), the fetch (`AbortSignal.any` with its own timeout) and the retry
  backoff on it, as `CallCancelled` — deliberately not an `ApiError`, so no
  code that answers around a Steam failure can mistake the client's decision
  for one. A shared cached request is never aborted for one caller: that
  caller only stops waiting (`untilCancelled`).
- Keep clients fetch only (caching is the request's `cache: true` option); all raw→agent-facing shaping lives in
  `src/format/` (`storefront.ts` / `web.ts` / `webAchievements.ts` / `store.ts`
  over the `storeCard.ts` toolkit, generic helpers in
  `shared.ts`). Every exported summarizer builds its return value via its
  co-located schema's `schema.parse({...})` (schema-first: the schema is the
  single source of truth, so the shaper and its `outputSchema` can't drift
  apart) — `.parse()` calls and schema imports belong only in `format/`, never
  in `clients/`. One deliberate exception: `summarizePurchasePrices` shapes a
  Steam payload that only feeds a price correction, so it `safeParse`s and
  throws a `bad_response` ApiError on a mismatch (Steam's unusable answer,
  costing the correction) instead of `parse` (our bug, failing the call). Trim responses for token efficiency (cap big lists like a
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
- **Work directly on `main`** — single-developer repo, so no feature branches
  (a forgotten branch silently drifts: one sat unmerged for a month and needed
  a conflicted rebase to land). Commit straight to `main`; only branch if the
  maintainer explicitly asks for one.
- **CodeQL** (`.github/workflows/codeql.yml`) scans `javascript-typescript` on
  push/PR to main plus a weekly cron — no local equivalent command; findings
  surface under the repo's **Security → Code scanning** tab.

## Testing the live/published server

For a full audit of the currently published (or just-fixed) package —
build/test/lint plus hammering the live MCP tools with edge cases,
cross-checked against source — follow
[.agents/skills/live-audit/SKILL.md](.agents/skills/live-audit/SKILL.md).
It covers the keyless-vs-key-gated tool split, SteamID64/appid edge cases,
and known bug classes found in past passes worth checking don't recur. For a
diff that touches error-handling or partial-failure resilience specifically (a new
`Promise.allSettled`/try-catch), also run `/code-review` (or an equivalent
static-reasoning pass) over it — live-testing structurally can't trigger one
specific sub-request's failure on cue, so bugs in that exact path (an
unsanitized error message, an outer `Promise.all` quietly defeating the fix)
need the code read, not called.

## Reading a reported stack

An internal error is logged with its stack (stderr), from a minified bundle
whose frames read `dist/index.js:<line>:<col>`. The build is reproducible and
`--sourcemap` doesn't move the code, so map it back: check out the release
tag, `npm ci`, then its own bundler with `--sourcemap` (`npx tsdown
--sourcemap` from 0.18; `npx tsup --sourcemap` for the tsup-built tags up to
0.17.x, run from the tag's `node_modules`), then resolve each frame with
`node:module`'s `SourceMap` (`new SourceMap(JSON.parse(readFileSync(
"dist/index.js.map"))).findEntry(line - 1, col - 1)` → `originalSource`,
`originalLine + 1`). No sourcemap ships: the `.mcpb` excludes it anyway.
This holds because `release.yml` builds and publishes from the tag in CI
(`npm ci`, `npm run build`, `npm publish --provenance`) — verified: the
published 0.17.2 `dist/index.js` and a rebuild of tag `v0.17.2` are
byte-identical. Never publish a hand-built `dist/`.

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
