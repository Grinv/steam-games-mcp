# Notes (personal, not load-bearing)

- Claude Code's `TaskCreate` tool only accepts one task per call (`subject` +
  `description`, no array/batch param). Consider whether a batch-create
  wrapper (e.g. an MCP tool) would be useful, or whether it's worth raising as
  feedback upstream to Anthropic.

- On MCP TypeScript SDK v2 stable (`@modelcontextprotocol/{server,client,core,codemod}@2.0.0`),
  split from the old `@modelcontextprotocol/sdk` package. `src/server.ts` uses
  `serveStdio` (SEP-2577 era negotiation) over stdio only — no HTTP/SSE/OAuth
  transport, so the Express/Hono/Workers-adapter parts of the SDK don't apply
  here. No MCP `logging` capability (dropped; `lib/logger.ts`'s
  `createLogger(config.logLevel)` writes stderr-only, no sink) and no
  sampling/elicitation/roots usage anywhere in the codebase. The current
  protocol revision (`2026-07-28`) marks all four of those capabilities
  deprecated (SEP-2577) but still functional — if structured logging is ever
  needed, the suggested replacement is stderr plus OpenTelemetry, not the MCP
  `logging` capability. If elicitation is ever added, use the `inputRequired`
  API — the older `elicitInput` throws on this protocol revision.
