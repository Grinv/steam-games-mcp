# Tool descriptions: what to check before committing

When adding or editing a tool's `description` (or a schema field's
`.describe()`), self-check it against Glama's [Tool Definition Quality Score
(TDQS)](https://github.com/glama-ai/tool-definition-quality-score) rubric —
the same one that scores this server at
[glama.ai/mcp/servers/Grinv/steam-games-mcp/score](https://glama.ai/mcp/servers/Grinv/steam-games-mcp/score).
There's no way to force an instant re-score there (Glama re-analyzes on its
own schedule, not on push), so treat this as a manual pre-commit check, not
something to verify live after every edit.

## The six dimensions (weight, question)

| Dimension               | Weight | Question                                                           |
| ----------------------- | ------ | ------------------------------------------------------------------ |
| Purpose Clarity         | 25%    | Does the description state what the tool does?                     |
| Usage Guidelines        | 20%    | Does it say when to use this tool vs alternatives?                 |
| Behavioral Transparency | 20%    | Does it disclose behavior beyond what annotations already provide? |
| Parameter Semantics     | 15%    | Does it add meaning beyond what the input schema provides?         |
| Conciseness & Structure | 10%    | Is it appropriately sized and front-loaded?                        |
| Contextual Completeness | 10%    | Given the tool's complexity, is the description complete enough?   |

Usage Guidelines and Behavioral Transparency carry the most weight after
Purpose, and are the two dimensions most worth double-checking on a new tool.

## What actually moves the score (learned by self-applying it here)

- **Name the alternative tool.** "Use X instead of Y when Z" is the single
  highest-leverage fix for Usage Guidelines. Every pair of tools that could
  plausibly be confused (similar inputs, overlapping domain) should cross-
  reference each other — e.g. `get_items` vs `get_prices` (both batch by
  appid; differ in richness vs appid limit), `get_global_achievements` vs
  `get_game_achievements` (rarity-only vs full schema).
- **Disclose the return shape, not just "no key needed."** Behavioral
  Transparency rewards concrete consequences — field names returned, caps,
  ordering, visibility/privacy caveats — over a generic aside about the key.
  Compare: `get_prices` says rows preserve input `appids` order and mark
  unavailable ones rather than dropping them; that's what earns real credit,
  not "No API key required" alone.
- **Parameter Semantics has a structural ceiling.** If a schema's
  `.describe()` coverage is already ~100% (this repo's convention — see the
  Conventions section in [AGENTS.md](../AGENTS.md)), the rubric's own baseline
  is 3/5 for that dimension _even with a perfect description_ — restating
  schema fields in prose adds no information and isn't rewarded. Don't chase
  this by padding descriptions; only add prose when there's a genuinely
  non-obvious fact the schema can't express (e.g. `search_games`'s `term`
  accepting partial/fuzzy matches, not full titles).
- **Never contradict an annotation.** A description implying a side effect a
  `readOnlyHint: true` tool doesn't have is an automatic floor score on
  Behavioral Transparency.

## Full spec

The [repo README](https://github.com/glama-ai/tool-definition-quality-score)
is the complete methodology: scoring pipeline, exact LLM prompts (Appendix A),
calibration examples, and weight formulas. Read it once for the calibration
examples if a description edit isn't clearly hitting 4-5 on the dimension
you're targeting.
