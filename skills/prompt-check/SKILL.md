---
name: prompt-check
description: Live-test every MCP Prompt in src/tools/prompts.ts through the real MCP protocol (not a static read) across every argument combination. Use when a prompt is added or its argument-handling logic changes, or as part of a live-audit pass.
---

# Prompt check — live-test every MCP Prompt argument combination

A static read comparing prompt text against tool names/params misses
argument-handling bugs. Actually render every prompt through the real MCP
protocol:

```sh
npx @modelcontextprotocol/inspector --cli node dist/index.js --method prompts/list
npx @modelcontextprotocol/inspector --cli node dist/index.js --method prompts/get \
  --prompt-name <name> --prompt-args key=value key2=value2
```

`--prompt-args` takes space-separated `key=value` pairs, **not** a JSON blob
— the CLI rejects JSON with "Invalid parameter format".

Run each prompt with no args, with only one of several optional args set at
a time, and with all of them set — an argument that's individually optional
can still have a bug that only shows up when given alone. Also try a
whitespace-only value (`"   "`) for every optional string arg, not just
omitted-vs-present: it's truthy in JS, so a missing `.trim()` on
prompts.ts's own argsSchema (separate from tools/*.ts's, and not
automatically covered by a tool-schema trim fix like 61fe40a) slips past a
`field ? ... : ...`/`field ?? "default"` check the same way an actually-set
value would.

**Watch out for a SteamID64 argument specifically**: the inspector CLI's own
`--prompt-args key=value` parsing silently coerces a numeric-looking value
through a JS number, and a 17-digit SteamID64 exceeds
`Number.MAX_SAFE_INTEGER` — it comes out the other side with its last couple
of digits corrupted (e.g. `...930` → `...940`), even though the prompt's own
`z.string()` schema never asked for that. Confirmed this is the inspector's
bug, not this server's, by sending the identical `prompts/get` call as raw
JSON-RPC over stdio (a JSON string round-trips exactly) — don't spend time
chasing this as a steam-games-mcp finding if it recurs; just verify any
SteamID64-argument prompt test that way instead of trusting the inspector
CLI's rendering of the digits.
