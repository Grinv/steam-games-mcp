---
name: live-audit
description: Audit steam-games-mcp — build/test/lint gate, live MCP tool edge-case sweep (input validation, SteamID64/vanity/appid edge cases, key-gating), and source-level code review. Use when asked to test/audit the published or just-fixed steam-games-mcp package, hunt for bugs/edge cases, or repeat "the same kind of testing as before."
---

# live-audit — steam-games-mcp health check + edge-case hunt

Repo-specific playbook, for any agent/model working on this repo (not tied to
a particular harness — see `AGENTS.md`'s own agent-agnostic framing). Use it
when asked to test/audit the published or just-fixed steam-games-mcp package,
hunt for bugs/edge cases, or repeat "the same kind of testing as before."
Sibling repos (`tmdb-mcp`, `mal-mcp`, `anilist-mcp-server`) keep their own
`skills/live-audit/SKILL.md` — when either this file or a sibling's improves,
sync the useful parts both ways rather than letting them drift.

Goal: find real bugs/inaccuracies in the live tool behavior (against the real
Steam Storefront + Web APIs) and in the source, then fix what's found. Read
`AGENTS.md` first if it's not already in context — every fix must follow its
conventions (`guard()`/never-throw, schema-first `format/*.schemas.ts`,
keyless-vs-keyed tool gating, commit author/no-Co-Authored-By, etc.).

This assumes the server is already reachable as an MCP connection in your
current session (e.g. as `mcp__steam__*` tools in Claude Code). If it isn't
connected, connect it first rather than skipping straight to step 1.

**Unlike the anilist/mal siblings, this server has no OAuth login and no
mutation tools** — every tool is a read against public Steam data. The
per-call risk here isn't "did I just modify a real account," it's "did I just
call a key-gated tool without a key," "did I treat a private profile's
default response as a bug," or "did I burn a real person's SteamID64 in a
committed test fixture." Read `## 2` before live-calling anything.

## Contents

- 0. Confirm "published"/"fixed" actually means what you think it means
- 1. Static pass first (cheap, catches regressions before you burn API calls)
- 2. Safety rules for live testing (read before calling anything)
- 3. Live edge-case sweep
- 4. Source-level code review
- 5. Docs/metadata consistency
- 6. Report, then fix only what's confirmed
- 7. Commit + changelog, if asked

## 0. Confirm "published"/"fixed" actually means what you think it means

```sh
node -p "require('./package.json').version"; npm view steam-games-mcp version; git log --oneline -5
```

If `package.json`'s version matches the npm-published version, live-testing
the running tools _is_ testing the published package. If you've since made
local fixes, remember the running MCP server is a **separate process** from
your edits — stdio servers don't hot-reload. Ask for a restart before
trusting a live call against fixed code, and state plainly whether findings
apply to the published package or to fixed-but-unreleased/unrestarted code.

## 1. Static pass first (cheap, catches regressions before you burn API calls)

```sh
npm run build && npm test && npm run lint && npm run format:check
```

Optionally `npm run check:api` too — it's a live upstream health-check
(Storefront + keyless Web API always run; key-gated Web API checks only run
if `STEAM_API_KEY` is exported in your shell). A failure there means an
upstream shape has drifted, which is exactly the kind of thing this audit is
hunting for — treat it as a finding, not noise to route around.

All green is a **baseline, not proof of correctness** — it only confirms
nothing already-covered regressed. It says nothing about whether the
interesting logic (error/exception branches especially) is covered at all.
`npm run test:coverage` (~80% gate) measures lines executed, not whether the
assertions on those lines are meaningful. When reviewing or writing tests as
part of this audit, ask: does a test exist that deliberately triggers this
error path (a private profile, a malformed SteamID64, a delisted appid), and
does it assert on the _specific_ resulting message/shape (not just
"isError: true")?

Also ask the same question about **protocol era**, not just error paths:
`src/__tests__/e2e.test.ts`'s default connections (`helpers.ts`'s
`connectServer()`, and the plain `new Client(...)` in e2e's first test) all
negotiate the legacy (2025) era — `versionNegotiation` defaults to `'legacy'`.
Only the tests that explicitly pass `{ versionNegotiation: { mode: 'auto' } }`
ever exercise the modern (2026-07-28) era, so any wire-level behavior that
differs by era (`serverInfo` stamping, `cacheHints`, a future
elicitation/sampling `input_required` path) needs its own modern-era test —
the legacy-era suite passing green proves nothing about it. Confirmed
concretely: `cacheHints` (added for `tools/list`/`prompts/list`/
`server/discover`) had to be verified with a dedicated modern-era connection
and a spy `ResponseCacheStore`, since the legacy-era suite would stay green
whether or not it worked at all.

Don't try to run the whole unit suite (the ~240+ `helpers.ts`-based tests)
under both eras — confirmed by direct test: a bare `McpServer.connect()` over
`InMemoryTransport` (what every one of those tests uses) doesn't negotiate
the modern era at all (`'auto'` silently falls back to legacy; `{pin:
'2026-07-28'}` fails outright with `EraNegotiationFailed`) — era negotiation
is `serveStdio`'s own hosting behavior, not something a bare `McpServer`
instance implements. Real dual-era coverage only works through a spawned
process (`e2e.test.ts`'s `StdioClientTransport` setup), which is too slow to
duplicate per-tool. Instead, extend `e2e.test.ts`'s
`assertRepresentativeSlice()` — one call per kind of protocol-level logic
(tool registration, a key-gated short-circuit, a schema-validation
rejection, a prompt call), not per tool — and keep every call inside it
network-free (short-circuits before any fetch, or touches no client at all)
since a live Storefront/Web API call has no place in the default `npm test`
gate.

Anything red here is the actual finding — stop and report it before moving to
live testing.

## 2. Safety rules for live testing (read before calling anything)

- **No account is authenticated and no tool mutates state** — every
  `mcp__steam__*` tool is a read. There is nothing to revert. The actual risks
  here are different from the anilist/mal siblings:
  - **Key gating.** Player-data tools (`get_player_summary`, `get_owned_games`,
    `get_recently_played`, `get_player_achievements`, `get_friend_list`,
    `find_friends_who_own`, `compare_players`, `get_player_bans`,
    `resolve_vanity_url`, `get_recommended_games`, and a few more in
    `src/tools/webPlayer.ts`) require `STEAM_API_KEY`. Confirm whether the
    session actually has one configured (`env | grep STEAM_API_KEY`, or just
    call one and read the error) before assuming a "set STEAM_API_KEY" error
    is a bug rather than the intended keyless-session message — but also
    confirm the message itself is accurate and actionable per AGENTS.md.
    Store/catalog tools (`search_games`, `get_game`, `get_specials`,
    `get_featured`, `discover_games`, `get_items`, `get_game_news`,
    `get_global_achievements`, `get_current_players`, `get_wishlist`,
    `get_followed_games`, `get_prices`, `get_review_histogram`,
    `get_game_reviews`) need no key at all — see AGENTS.md's "Keyless
    caveat" for exactly which Web API methods are keyless by design.
  - **Real people's data.** SteamID64-taking tools resolve to real Steam
    accounts. Prefer well-known/public test accounts or your own profile over
    guessing a random person's id; a target profile must be public for most
    fields to return anything meaningful — a private profile returning a
    trimmed/limited shape (not an error) is Steam's documented behavior, not
    automatically a bug. Never paste a real private individual's SteamID64,
    friend list contents, or owned-games list into a committed test fixture
    or a findings report beyond what's needed to describe the bug — use a
    public figure's/your own id, or a well-formed-but-fake one for pure
    validation-boundary tests.
  - **Rate limits.** Both the Storefront and Web API are shared, rate-limited
    upstreams (`src/lib/rateLimit.ts` backs off client-side). Batch
    independent lookups where possible, but don't hammer the same endpoint in
    a tight loop just to test caching — one confirming call is enough.
- **Read-only tools are always safe to call freely** — no special permission
  needed, since nothing is written or shared.

## 3. Live edge-case sweep

Batch independent tool calls together where your harness supports it — this
is slow one-at-a-time. Adapt ids/appids/tools to whatever's currently
registered (`grep -n 'registerTool(' src/tools/*.ts`), don't just replay last
run's exact calls verbatim. Split into independent workstreams if your
environment supports concurrent subagents/background tasks.

- **Input validation boundaries**: empty string where `.min(1)` is expected,
  negative/zero/decimal/way-past-int32 appids, a SteamID64 with the wrong
  digit count or out of the valid 64-bit range (e.g. accountid 0 — this has
  previously leaked raw upstream HTML instead of a clean `found:false`, see
  `CHANGELOG.md`'s 0.10.2 entry), batch `appids`/`ids` at their `.min()`/cap
  boundary and one past it, an unknown/misspelled param name.
- **SteamID64 / vanity edge cases**: a syntactically valid but nonexistent
  SteamID64, a vanity name that doesn't resolve, a vanity name containing
  URL-unsafe characters, a private profile (fields should degrade gracefully,
  not error), a profile with zero games/zero friends/zero achievements (empty
  array, not a crash), a VAC-banned or community-banned account via
  `get_player_bans`.
- **Appid edge cases**: a delisted/removed appid, a DLC or soundtrack appid
  (not a base game — does the tool's shaping assume "game" fields that don't
  exist?), a free-to-play appid (price fields), an appid with a region lock
  (`cc` param) that changes availability/price, a non-English `l`/`language`
  param that changes field content, an appid that exists on the store but has
  no reviews yet, an appid past `get_current_players`'/`get_game_achievements`'
  documented not-found behavior.
- **Cross-field pairing rules**: filters `discover_games`/`get_items` silently
  no-op on when a required partner is missing, `check_appids` in
  `get_owned_games` against a private profile (should this degrade to
  "unknown" rather than a false `owned:false`? see the 0.10.1 CHANGELOG
  entry for a real prior instance of exactly this bug), a `cc`/`l` pair that
  Steam silently ignores for one endpoint but not another.
- **Not-found / empty-result paths**: a search returning zero results, a
  batch (`get_items`, `get_owned_games`'s `check_appids`) mixing valid +
  invalid + duplicate ids, `find_friends_who_own` when one friend's own
  lookup errors transiently (should degrade into `unavailable_friends`, not
  sink the whole call — see the just-shipped fix in `git log`), an appid
  queried that's actually a non-game "app" (soundtrack/tool/demo) so a
  game-shaped assumption downstream breaks.
- **Payload-size risk**: anything that aggregates a variable-size collection
  — a very large game library (`get_owned_games`), a big friend list
  (`get_friend_list`, `find_friends_who_own`), a long achievement list
  (`get_player_achievements`, `get_global_achievements`), a large wishlist
  (`get_wishlist`), `discover_games`/`get_items` with a wide batch of appids.
  Check the actual response size/token count for the largest realistic case
  (e.g. a Steam account with 1000+ games, a game with 200+ achievements), not
  just that it returns _something_ — AGENTS.md calls out that these
  responses must be capped/trimmed.
- **Documented vs. actual shape**: for anything that looks surprising live,
  grep the field back to its `.describe()` text in `src/tools/*.ts` and its
  `format/*.schemas.ts` — does the tool's own description/outputSchema
  promise what you just saw (or promise something you didn't)?
- **Unicode / locale / injection-shaped input**: emoji-only search terms,
  non-Latin scripts in `search_games`, whitespace-only terms, a malformed
  `cc` (country code) or `l` (language) value that's shaped like a real one
  but isn't, SQL/HTML-injection-shaped strings in any free-text param — check
  the error message doesn't leak raw upstream HTML/markup (a real prior bug
  class in this repo, see `CHANGELOG.md` 0.10.2) or misattribute a transport
  error to "not found"/"private profile" when it's actually a 5xx/network
  blip.
- **Systematic input-schema fuzzing** across every tool: wrong JS types,
  invalid enums, missing required fields, malformed nested objects, extremely
  long strings. Only flag a genuine problem — an unhandled exception/stack
  trace, a confusing validation message, or (worse) malformed input silently
  accepted and producing a wrong result. A clean, expected Zod validation
  error is correct behavior, not a finding.
- **Live prompt testing**: run the `prompt-check` skill against every prompt
  in `src/tools/prompts.ts` — a static read comparing prompt text against
  tool names/params misses argument-handling bugs that only show up when
  actually rendered through the real MCP protocol (this skill also covers a
  SteamID64-specific inspector-CLI number-precision quirk worth knowing
  about here).

For anything that looks like a bug, **don't stop at the symptom** — grep the
source for the actual mechanism (the fetch call/regex/cap that produced it)
before calling it a finding. A live response that merely _looks_ odd but ties
back to correct, intentional code (e.g. Steam's own documented behavior for
private profiles, or `discover_games`'s deliberate/tested precedence of an
explicit `released_after` over `released_within_days` when both are given —
check `src/__tests__/steamCatalog.test.ts` before flagging a cross-field
interaction, it may already be intentional and covered) isn't a finding.

The same caution runs the other way: a finding produced by reading source
_without_ calling any live tool (e.g. a background/sub-agent doing a
static-only pass) is a hypothesis, not a confirmed bug — Steam's actual
upstream behavior sometimes contradicts what the code's shape implies (e.g.
whether a malformed id 400s cleanly vs. leaks raw HTML is something you have
to observe, not infer). Before reporting any source-only finding, spend one
live call confirming the actual response shape it depends on.

## 4. Source-level code review

**This step is not optional polish on top of live testing — some bug classes
are only reachable here.** Live-calling the real Steam API can't reliably
make one specific sub-request in a batch fail on cue, so partial-failure
resilience (`Promise.allSettled`/try-catch added to stop one item's failure
from sinking a batch) and where a caught error's message actually ends up
require reading the control flow, not another live call. Concretely: a
`/code-review` pass over the same diff caught two bugs in this exact category
that a thorough live pass had missed — a per-friend error message leaking
raw upstream content past the sanitizer, and a "fixed" resilience path still
wrapped in an outer `Promise.all` that silently defeated it. Don't skip this
step or treat live-testing's silence on a code path as evidence it's fine.

Sweep every file under `src/tools/`, `src/format/`, `src/clients/`, and
`src/lib/` (lighter pass on the last group unless something specific points
there) for:

- A tool whose field name for a concept diverges from every sibling tool
  handling the same concept (e.g. one player-data tool naming its
  SteamID64/vanity-name parameter differently from another). Grep every call
  site of a shared concept and diff the field names — don't just check each
  in isolation. No input schema in this codebase is `.strict()`, so a
  plausible-but-wrong name is silently dropped as an unrecognized key instead
  of erroring, and the tool quietly falls back to whatever its field being
  _absent_ means (e.g. an unfiltered/global result) — this looks like a
  legitimate answer, not a bug, unless you already know what the correctly-
  filtered result should look like. Confirmed live on a sibling project
  (anilist-mcp-server): a search tool's user-filter parameter was named
  differently from every other user-scoped tool, so passing the
  sibling-consistent (but wrong) name silently returned the unfiltered global
  feed instead of erroring or filtering.
- A shaper in `src/format/*.ts` that dereferences a raw Steam field unguarded
  instead of going through its co-located `*.schemas.ts`'s `schema.parse()` —
  AGENTS.md requires every summarizer build its return value that way so the
  shaper and its `outputSchema` can't drift.
- A raw upstream HTML/error page leaking through instead of a clean
  `found:false`/`isError` result — this exact bug class has recurred (0.10.2's
  malformed-SteamID64 fix, 0.10.1's `get_current_players`/`get_game` fixes).
  Check every call site that takes a user-controlled id/appid for the same
  "does a 400/404/5xx get normalized, or does raw upstream body leak through."
- A tool that assumes a private profile 404s instead of returning a
  restricted-but-200 shape (or vice versa) — Steam's actual behavior differs
  by endpoint, don't assume one implies the other for a sibling endpoint.
- A raw-response TS interface or a private/empty-detection helper (e.g.
  `isPrivate()`) reused across two upstream endpoints that merely _look_
  alike (same steamid-in/games-list-out shape) — confirmed recurring:
  `getRecentlyPlayed` reused `GetOwnedGames`' `OwnedGamesResponse`/`isPrivate`
  (keyed on `game_count`), but `GetRecentlyPlayedGames` actually answers with
  its own `total_count` field, so a public profile with zero recent playtime
  (`{total_count:0}`, no `games` key) was misreported as private for every
  release through v0.10.5. Grep every reused response type/helper across
  `src/clients/web.ts` and diff the real field name each endpoint returns —
  don't assume a sibling call shares the same upstream field names just
  because the TS type does.
- Missing bounds/caps on a collection-shaped response (owned games,
  achievements, friend list, wishlist) that AGENTS.md says must be trimmed —
  check the actual cap constant still matches what's documented in the tool's
  `.describe()` text.
- A key-gated tool in `src/tools/webPlayer.ts` that doesn't short-circuit
  cleanly through the shared key-check helper when `STEAM_API_KEY` is unset,
  or a keyless-capable tool in `src/tools/webStore.ts`/`storefront.ts` that
  accidentally requires the key when it shouldn't (re-check against AGENTS.md's
  "Keyless caveat" list of methods that work without one). Also check the
  *error-message* side of the same list: `HttpClient`'s `hasCredentials` is
  fixed per client instance (`lib/http.ts`), not per request — a
  keyless-capable method that sends the key when present (`web.ts`'s
  "keyless-capable" group) needs its own call site to override
  `hasCredentials: false`, or a 403 there gets misattributed to "the
  configured credentials are likely invalid" whenever any key is configured.
  Confirmed one sibling in that exact group (`getGlobalAchievements`) already
  had a fix; four others (`getNews`, `getCurrentPlayers`, `getFollowedGames`,
  `#getWishlistLight`) didn't, until this pass added the same override to all
  five — diff every method under that comment block, not just one.
- Tool failures that don't go through `guard()`/`result.ts` — AGENTS.md
  requires every tool failure return `{ isError: true }`, never a raw throw.
- `.clients/` files doing any response-shaping themselves instead of leaving
  it entirely to `src/format/` — AGENTS.md says clients are fetch+cache only.
- Logger/credential leakage: the Web API key travels as a `key` query param —
  confirm the logger (`src/lib/logger.ts`) still redacts it in whatever log
  line covers the newest client call, and that nothing writes to stdout
  (reserved for the MCP protocol channel).
- **A `Promise.allSettled`/try-catch newly added so one item's failure doesn't
  sink an entire batch call (e.g. `find_friends_who_own`'s per-friend
  ownership lookup)** — this bug class needs a source-level trace, not a live
  call, because you can't reliably make one specific sub-request fail on cue
  against the real API. Check two things: (1) does the rejection's raw
  `.message` reach agent-facing output unsanitized (route it through
  `messageFor()`/an equivalent sanitizer the same way a top-level tool
  failure does — never embed `r.reason.message` directly, since an
  `ApiError.message` can carry up to 500 raw characters of an upstream error
  body per `lib/http.ts`'s `toHttpError`, e.g. an HTML error page); (2) is
  that `Promise.allSettled` call itself still wrapped in an _outer_
  `Promise.all` alongside another call that can reject (e.g. a sibling
  batch/chunk-fetch helper like `#playerSummaries`) — if so, the outer
  `Promise.all` silently defeats the entire fix the moment that other call
  fails. Grep every sibling function in the same file doing similar
  batching/chunking for the identical un-fixed bug — a resilience fix applied
  to one `Promise.all` site often has an identical, still-broken twin call
  one function away that was never touched.

## 5. Docs/metadata consistency

Run the `docs-consistency-check` skill.

## 6. Report, then fix only what's confirmed

Rank findings by severity. For each: what's wrong, concrete repro (exact tool
call + params), the file/line causing it, and the fix shape. Silence on a
category you didn't get to (rather than implying full coverage) beats a false
"all clear." Then run the `self-learning` skill against each confirmed
finding.

If asked to fix: implement the smallest correct change, add/extend a test in
the matching `src/__tests__/*.test.ts` (mirror the existing test's style in
that file — `steamFixtures.ts` centralizes shared fixture shapes, reuse it
rather than inlining a new one), then re-run the full
`build && test && lint && format:check` gate before calling it done. Re-verify
live only after the running MCP server process has been restarted (it won't
pick up source changes on its own) — build/test passing is necessary but
re-confirming actual live behavior changed is stronger evidence than trusting
the diff alone.

## 7. Commit + changelog, if asked

One `fix:`/`feat:` commit per logically distinct change (don't bundle two
unrelated fixes into one commit), then a separate `docs:` commit adding to
`CHANGELOG.md`'s `[Unreleased]` section (style: the `changelog-style` skill)
with one bullet per fix, each linking that fix commit's short sha
(`https://github.com/Grinv/steam-games-mcp/commit/<7-char-sha>`).
Author/committer `Grinv <4070730+Grinv@users.noreply.github.com>`, **no**
`Co-Authored-By` trailer (AGENTS.md's commit convention). Don't push unless
explicitly asked.
