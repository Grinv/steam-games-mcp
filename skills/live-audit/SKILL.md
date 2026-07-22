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
- **Live prompt testing** (`src/tools/prompts.ts`) — a static read comparing
  prompt text against tool names/params misses argument-handling bugs.
  Actually render every prompt through the real MCP protocol:
  `npx @modelcontextprotocol/inspector --cli node dist/index.js --method
prompts/list`, then `--method prompts/get --prompt-name <name>
--prompt-args key=value key2=value2` (space-separated `key=value` pairs, NOT
  a JSON blob — the CLI rejects JSON with "Invalid parameter format"). Run
  each prompt with no args, with only one of several optional args set at a
  time, and with all of them set — an argument that's individually optional
  can still have a bug that only shows up when given alone. Watch out for a
  SteamID64 argument specifically: the inspector CLI's own `--prompt-args
key=value` parsing silently coerces a numeric-looking value through a JS
  number, and a 17-digit SteamID64 exceeds `Number.MAX_SAFE_INTEGER` — it
  comes out the other side with its last couple of digits corrupted (e.g.
  `...930` → `...940`), even though the prompt's own `z.string()` schema never
  asked for that. Confirmed this is the inspector's bug, not this server's, by
  sending the identical `prompts/get` call as raw JSON-RPC over stdio (a JSON
  string round-trips exactly) — don't spend time chasing this as a steam-games-mcp
  finding if it recurs; just verify any SteamID64-argument prompt test that way
  instead of trusting the inspector CLI's rendering of the digits.

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

Sweep every file under `src/tools/`, `src/format/`, `src/clients/`, and
`src/lib/` (lighter pass on the last group unless something specific points
there) for:

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
- Missing bounds/caps on a collection-shaped response (owned games,
  achievements, friend list, wishlist) that AGENTS.md says must be trimmed —
  check the actual cap constant still matches what's documented in the tool's
  `.describe()` text.
- A key-gated tool in `src/tools/webPlayer.ts` that doesn't short-circuit
  cleanly through the shared key-check helper when `STEAM_API_KEY` is unset,
  or a keyless-capable tool in `src/tools/webStore.ts`/`storefront.ts` that
  accidentally requires the key when it shouldn't (re-check against AGENTS.md's
  "Keyless caveat" list of methods that work without one).
- Tool failures that don't go through `guard()`/`result.ts` — AGENTS.md
  requires every tool failure return `{ isError: true }`, never a raw throw.
- `.clients/` files doing any response-shaping themselves instead of leaving
  it entirely to `src/format/` — AGENTS.md says clients are fetch+cache only.
- Logger/credential leakage: the Web API key travels as a `key` query param —
  confirm the logger (`src/lib/logger.ts`) still redacts it in whatever log
  line covers the newest client call, and that nothing writes to stdout
  (reserved for the MCP protocol channel).

## 5. Docs/metadata consistency

Check every one of these, not just a sample:

- `README.md`'s tool table matches `src/server.ts`'s registrations (names,
  and the keyless-vs-key-gated column against each tool's actual behavior).
- `manifest.json`'s and `server.json`'s `tools` arrays list the same tool
  **names** as what's actually registered (`npm test`'s `e2e.test.ts` already
  asserts this — treat a failure there as authoritative). Their `description`
  fields are deliberately short, independent marketing-style summaries, NOT a
  copy of the tool's full `.describe()`/`description` text in
  `src/tools/*.ts` — don't "fix" them to match verbatim, that's not a bug. Do
  re-read them for accuracy if a tool's _behavior_ changed in a way the short
  summary now misrepresents.
- Tool `description`/field `.describe()` text in `src/tools/*.ts` itself:
  does it still match the actual `inputSchema`/`outputSchema` and the real
  behavior? Cross-check new/edited descriptions against
  `docs/tool-descriptions.md` (Glama's TDQS rubric) per AGENTS.md.
- `CHANGELOG.md`'s `[Unreleased]` section (see `docs/changelog-style.md` for
  entry style) has one line per real behavior change made in this pass — add
  missing entries, don't just flag them as missing.
- `AGENTS.md`'s "Keyless caveat" list and its `src/` tree (and this `skills/`
  entry) still match the filesystem and the actual keyless method list.
- `docs/notes.md`, `docs/releasing.md`, `docs/clients.md` and any other
  `docs/*.md` for stale phrasing (e.g. describing something as "once
  published"/"upcoming" that already shipped).

## 6. Report, then fix only what's confirmed

Rank findings by severity. For each: what's wrong, concrete repro (exact tool
call + params), the file/line causing it, and the fix shape. Silence on a
category you didn't get to (rather than implying full coverage) beats a false
"all clear."

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
`CHANGELOG.md`'s `[Unreleased]` section (style: `docs/changelog-style.md`)
with one bullet per fix, each linking that fix commit's short sha
(`https://github.com/Grinv/steam-games-mcp/commit/<7-char-sha>`).
Author/committer `Grinv <4070730+Grinv@users.noreply.github.com>`, **no**
`Co-Authored-By` trailer (AGENTS.md's commit convention). Don't push unless
explicitly asked.
