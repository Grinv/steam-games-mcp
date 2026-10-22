# Notes (personal, not load-bearing)

- Claude Code's `TaskCreate` tool only accepts one task per call (`subject` +
  `description`, no array/batch param). Consider whether a batch-create
  wrapper (e.g. an MCP tool) would be useful, or whether it's worth raising as
  feedback upstream to Anthropic.

- On MCP TypeScript SDK v2 (`@modelcontextprotocol/{server,client}@2.3.1`),
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

- Deferred until the Node floor reaches 24 (Node 22 is EOL 2027-04-30):
  - bring back `using`/`await using` in tests (the e2e sandbox/client and
    `connectServer` teardown currently go through `t.after()`; Node 22's V8
    12.4 can't parse `using` under native type stripping);
  - try `AbortSignal.timeout()` in `src/lib/http.ts` `#once` again — on Node
    22 the mocked-fetch timeout tests get cancelled ("event loop has already
    resolved"), on 24/26 they pass (see the comment there);
  - widen `tsconfig.json` `lib` from `ES2024` + `ES2025.Collection`/
    `ES2025.Iterator` to full `ES2025` (`Promise.try`, `RegExp.escape`,
    `Float16Array`), and bump the tsup `target` to `node24`.

- Move `eslint.config.js` to `eslint.config.ts` once ESLint loads TS configs
  natively without `--flag unstable_native_nodejs_ts_config` (ESLint 10.13
  still needs that flag or the `jiti` dependency). It is already type-checked
  via `allowJs`/`checkJs` + `defineConfig()`, so this is cosmetic.
