---
name: tool-description-check
description: Self-check a new or edited MCP tool `description`/field `.describe()` text before committing — verify every behavioral claim against live testing or source, check for contradictions with sibling tools, and score against Glama's Tool Definition Quality Score (TDQS) rubric. Use whenever a tool description or schema field description in src/tools/*.ts is added or changed.
---

# Tool descriptions: what to check before committing

Published research on this exact failure mode: [Glama's TDQS
methodology](https://github.com/glama-ai/tool-definition-quality-score) found
97% of 856 tools across 103 real MCP servers have a description defect — 56%
don't clearly state what the tool does, 89% don't say when to use it.
Separately, "From Docs to Descriptions" measured that strong descriptions get
260% more selection in competitive scenarios and lift task success ~6 points.
Bad descriptions aren't a hypothetical risk; they're the median case. This
server is scored on the same rubric at
[glama.ai/mcp/servers/Grinv/steam-games-mcp/score](https://glama.ai/mcp/servers/Grinv/steam-games-mcp/score)
(re-analyzed on Glama's own schedule, not on push — treat this as a manual
pre-commit check, not something to verify live after every edit).

| TDQS dimension          | Weight | Question                                                           |
| ----------------------- | ------ | ------------------------------------------------------------------ |
| Purpose Clarity         | 25%    | Does the description state what the tool does?                     |
| Usage Guidelines        | 20%    | Does it say when to use this tool vs. alternatives?                |
| Behavioral Transparency | 20%    | Does it disclose behavior beyond what annotations already provide? |
| Parameter Semantics     | 15%    | Does it add meaning beyond what the input schema provides?         |
| Conciseness & Structure | 10%    | Is it appropriately sized and front-loaded?                        |
| Contextual Completeness | 10%    | Given the tool's complexity, is the description complete enough?   |

Usage Guidelines and Behavioral Transparency carry the most weight after
Purpose Clarity — double-check those two first on any new or edited tool.

## Two rules that override everything below

1. **No unverified claims.** Every behavioral statement in a description —
   not just "the schema allows this input," which is self-evidently true,
   but "here's what happens when you send it" — must be backed by one of:
   - an existing [docs/architecture.md](../../docs/architecture.md) "verified
     live" claim (e.g. its Keyless caveat / API references sections), cited
     by reference instead of re-asserted from memory;
   - a fresh live call against the real Storefront/Web API made during this
     review, with the actual response observed;
   - direct reading of the exact function implementing the behavior, when
     it's deterministic code logic rather than an upstream API's quirk (e.g.
     `format/store.ts`'s `summarizeItems`/`getPrices` marking an unknown
     appid `available:false` instead of erroring — that's this repo's own
     code, not Valve's).

   If you can't tick one of these, don't write the claim. "This is probably
   how it works by analogy with a similar field" is exactly how a sibling
   project shipped a bug where a description claimed a field was "computed
   and accurate" when it was never computed at all, and a cross-reference
   bug where one tool's description claimed another tool's field pointed
   callers to fetch first, when that field's own text never said that —
   both from one session of otherwise-careful editing.

2. **No contradictions or inconsistent disclosure between tools.** A claim
   in tool A's description about tool B, a shared value, or a shared
   behavior must match what B actually says and does — and if A and B share
   the exact same underlying behavior, both should disclose it, not just
   whichever one you happened to edit first. Concretely in this repo:
   `get_prices`'s description already states unavailable appids come back
   `available:false` rather than being dropped; `get_items` hits the exact
   same "unknown appid → `available:false`" path in `format/store.ts`
   (`summarizeItems`) but its own description in `tools/webStore.ts` doesn't
   say so yet — that's a real, currently-open gap this rubric would catch.
   Named examples like this one in this file are live checklist items, not
   historical color — verify each is still open and close it, don't read
   past it as background while auditing something else.
   When you edit one description, re-read every sibling description that
   cross-references it or shares its underlying data — fixing A while
   leaving a now-stale or now-inconsistent claim in B is still a bug you
   introduced this session, not a pre-existing one.

## Checklist

### Purpose and when to call it

- State what the tool does **and** when to call it — a trigger condition
  ("call this when the user asks about X"), not just a return-value
  description (a measured effect on newer, tool-call-conservative models,
  per Anthropic's own tool-use guidance — not just style).
- Give the tool itself a clear, specific name — verb + resource, not a bare
  noun. An agent screens dozens of tool names before it ever reads a
  description; a vague or overlapping name loses the match before the
  description gets a chance to help.
- Name the alternative tool for every pair that could plausibly be confused
  (similar inputs, overlapping domain) — "use X instead of Y when Z" is the
  single highest-leverage fix for this dimension. Make it bidirectional: if
  Y's description points to X, X's own description should acknowledge that
  role. This repo already does this well in a few places worth matching the
  style of: `get_items` ("for a bigger batch ... use get_prices instead")
  cross-references `get_prices` ("if you also need review %, ... use
  get_items instead"); `get_global_achievements` (rarity-only, catalog-wide)
  cross-references `get_game_achievements` (a specific player's own unlock
  state).
- Don't split one concept across near-duplicate tools, and don't collapse
  unrelated actions into one tool with a mode flag — one tool, one job,
  matching how this project already groups by domain (storefront reads vs.
  key-gated player reads) rather than by raw API endpoint.
- When genuinely unsure whether a description will make an agent pick the
  right tool among lookalikes, test it: prompt a fresh model with the
  candidate tools and a representative request (e.g. "is this game playable
  on Steam Deck" — `discover_games`'s `steam_deck` filter vs. `get_items`'s
  per-game `steam_deck` field), see what it actually picks, and adjust the
  text from that observed choice — not from how it reads to you. This
  checks selection _effectiveness_, a different failure mode from the
  fact-_correctness_ rule above.

### Parameter semantics

- Name a field for what it actually accepts, not a generic ID suffix — see
  this project's own AGENTS.md Conventions section for the exact naming
  rule (`steamid` accepts only a 17-digit SteamID64; a vanity/custom profile
  name is the separate `vanity` field resolved via `resolve_vanity_url`) —
  and check new fields against every sibling tool handling the same concept
  (`steamid` is one shared exported schema in `tools/webShared.ts`, reused
  verbatim by every key-gated player tool — don't redeclare it locally with
  a different name or shape).
- If a field's coverage is already ~100% `.describe()` (this project's
  baseline), don't pad prose restating the schema — TDQS's own rubric caps
  this dimension at 3/5 regardless. Only add text for a genuinely
  non-obvious fact the schema can't express on its own (e.g. `search_games`'s
  `term` accepting partial/approximate matches, not just exact titles).
- Every numeric range or enum the prose promises must be enforced in the
  schema itself (`.min()`/`.max()`/an enum type) — e.g. `get_items`'s
  "1-100 appids" and `get_prices`'s "1-500 appids" are both backed by
  `.min(1).max(...)`, not just prose. A described bound with no matching
  constraint is a lie the schema doesn't back up.
- Mark a field `required` only if the tool genuinely can't work without it,
  and give every optional field a sensible default (stated in its
  `.describe()` if non-obvious — e.g. `steamid`'s "omit to use the
  STEAM_ID configured on the server"). A truly-required field marked
  optional forces a caller to guess whether omitting it is safe; the
  reverse adds friction to every call for no reason.
- If a field accepts two forms (e.g. `get_game`'s `appid` OR `name`) and one
  form is validated against real data differently than the other, say so.
  Check this doesn't silently drift true over time — right now both forms
  of `get_game` do error clearly (`resolveAppId` returns null → "No Steam
  game found matching ..."; an unresolvable appid throws `not_found`), so
  there's nothing to disclose today; but don't assume that stays true after
  an edit without re-checking `clients/storefront.ts`.

### Mutations

This repo is genuinely read-only against Steam's public Storefront and Web
APIs — every registered tool carries `readOnlyHint: true` (`common.ts`'s
`READ_ONLY`, applied uniformly across `tools/storefront.ts`, `webStore.ts`,
and `webPlayer.ts`), and there is no login/session flow or write endpoint
anywhere in `src/clients/` or `src/tools/`. There is nothing to check under
this heading unless that changes — if a future tool ever writes state (e.g.
a Steam login/session-backed mutation), port the anilist-mcp-server
`AGENTS.md`/skill's "Mutations — behavioral transparency" section
(full-replace-vs-merge, upsert semantics, annotation honesty) back in at
that point rather than reconstructing it from scratch.

### Reads — behavioral transparency

- Distinguish "genuinely zero results" from "silently filtered out by a
  bad/unrecognized input" wherever the upstream API doesn't error on a
  mismatch — an unrecognized `tags` name in `discover_games`, an
  out-of-range `appid` that Steam just omits from a batch response, an
  unresolvable vanity name. Apply this **consistently across every sibling
  field of the same shape** — if one filter says "an invalid value just
  filters to nothing, not an error," every other field with the identical
  underlying behavior needs the same sentence, not just the one you
  happened to test first (see the `get_items`/`get_prices` gap called out
  above — same behavior, only one description states it).
- A shared/reused description or output-schema caveat must be re-verified
  against _this specific tool's_ actual query/endpoint — it can be correct
  for the sibling it was copied from and wrong here (e.g. `get_items`'s tag
  list is display-only and never filters, while `discover_games`'s `tags`
  field does filter — don't let one tool's caveat about tags bleed into the
  other's description unexamined).
- Disclose the return shape's real substance, not just the "no API key
  needed" caveat — fixed caps (`get_friend_list`'s 100-most-recent,
  `get_game_achievements`'s `ACHIEVEMENTS_MAX`), ordering (`get_prices`
  preserves input-appid order), and which nested fields a specific tool
  omits that a same-shaped sibling includes. This is the same rigor as the
  output schema's own field descriptions, not just the top-level
  description's prose.

### Conciseness, title, and structure

- Front-load the single most important fact (what + when) in the first
  sentence — a caller reads the opening far more reliably than the tail of a
  long description. Keep total length proportional to actual complexity.
- Keep `title` a short, literal human label — it's the UI-facing name, not a
  second description; don't duplicate `description`'s content there.

## Verify, then fix the implementation before dumbing down the description

When a true fact would make a description more useful but the code doesn't
actually do it yet (e.g. a field the description could confidently promise
if the client computed it), prefer fixing the implementation to match the
better description over writing a weaker, technically-safe sentence — as
long as the fix is small, deterministic, and doesn't change any other
observable behavior. Only fall back to narrowing the claim when the fix
would be a real feature addition, not a one-line gap-filler.

## Full spec

The [repo README](https://github.com/glama-ai/tool-definition-quality-score)
is the complete TDQS methodology: scoring pipeline, exact LLM prompts
(Appendix A), calibration examples, and weight formulas. Read it once for
calibration examples if an edit isn't clearly hitting 4-5 on the dimension
you're targeting.

## Keep this checklist honest against drift

This is an incremental, diff-based check by design — "new or edited"
descriptions — which means a rule added here today says nothing about
whether _already-registered_ tools already violate it. A sibling repo in
this project family (anilist-mcp-server) found exactly that gap live: its
"never contradict an annotation" rule (an `idempotentHint: true` tool whose
own description says a repeat call errors, not no-ops) was added in a fix
commit that corrected _other_ tools' descriptions — but the delete-tool
annotations that rule was written to catch were never rechecked against it
at the same time, and stayed wrong from the very first release through
several audits after.

- **A new or tightened rule here implies an immediate retroactive sweep, not
  just future guidance.** When you add or tighten a rule in this file, run
  it against every currently registered tool (not just the one you're
  editing) before considering the update done, and fix what it finds in the
  same pass.
- **Periodically run this whole checklist as a full sweep**, not only on
  new/edited descriptions — e.g. before a release, or whenever asked for a
  broader audit — since incremental diff-based checking alone lets an
  already-registered tool drift out of compliance forever once nobody edits
  it again.
