# Notes (personal, not load-bearing)

- Claude Code's `TaskCreate` tool only accepts one task per call (`subject` +
  `description`, no array/batch param) — hit this 2026-07-14 while trying to
  queue a multi-step todo list in one call. Think about whether a batch-create
  wrapper (e.g. an MCP tool) would be useful, or whether it's worth raising as
  feedback upstream to Anthropic.

- MCP TypeScript SDK v2 (`2.0.0-beta.4` as of 2026-07-18, not yet stable) will
  split `@modelcontextprotocol/sdk` into `@modelcontextprotocol/server` +
  `/client` + `/core`. Checked our exposure: we already use `registerTool`
  (not the deprecated `.tool()`), already on `zod ^4.2+`, and no handler
  touches the second `extra`/`ctx` param — low migration cost, mostly import
  path changes in `src/server.ts`, `src/tools/*.ts`, and the test files
  importing from `@modelcontextprotocol/sdk/client/*` / `/inMemory.js` /
  `/types.js`. There's an official codemod
  (`npx @modelcontextprotocol/codemod@beta v1-to-v2`).
  One thing to watch: protocol version `2026-07-28` (the GA release we'd be
  bumping to) marks `logging`, `sampling`, `elicitation`, and `roots` as
  deprecated (SEP-2577). We only touch `logging` — our
  `mcpLoggingSink`/`activateClientLoggingOnInitialize` (`src/server.ts`) is
  built on `capabilities.logging` + `sendLoggingMessage`; we don't use
  sampling/elicitation/roots at all. Still works during the deprecation
  window; the suggested replacement is plain stderr logging (already our
  fallback sink) plus OpenTelemetry for anything structured. Re-check when
  v2 goes stable and decide whether to just drop the MCP logging
  capability in favor of stderr-only.
  Verified directly in `@modelcontextprotocol/server@2.0.0-beta.4`'s
  built `dist/` (2026-07-20): `sendLoggingMessage`/`logging/setLevel`/
  `roots/list` are tagged "Remains functional during the deprecation
  window (at least twelve months)" — so bumping now would NOT break our
  logging on the day of the bump. Separately, `elicitInput` there is
  documented to _throw_ on a 2026-07-28-era request unless migrated to
  the new `inputRequired` API — a hard break, not a soft deprecation, but
  irrelevant to us since we don't call elicitation anywhere.

  **Resolved 2026-07-21**: migrated to v2 on the `sdk-v2-migration` branch,
  adopting `serveStdio` (SEP-2577 era negotiation) and dropping the MCP
  logging capability entirely — `mcpLoggingSink`/`activateClientLoggingOnInitialize`
  and `capabilities.logging` are gone from `src/server.ts`; logging is now
  stderr-only via `lib/logger.ts`'s plain `createLogger(config.logLevel)`
  (no sink). No point keeping a deprecated push-notification flow we'd already
  earmarked for removal once v2 landed.
