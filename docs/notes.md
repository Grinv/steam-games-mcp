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
  One thing to watch: the logging/sampling/roots subsystems are marked
  `@deprecated` as of protocol version `2026-07-28`, and our
  `mcpLoggingSink`/`activateClientLoggingOnInitialize` (`src/server.ts`) is
  built on the logging one (`capabilities.logging` + `sendLoggingMessage`).
  Still works, just deprecated — re-check when v2 goes stable.
