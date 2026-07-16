# Notes (personal, not load-bearing)

- Claude Code's `TaskCreate` tool only accepts one task per call (`subject` +
  `description`, no array/batch param) — hit this 2026-07-14 while trying to
  queue a multi-step todo list in one call. Think about whether a batch-create
  wrapper (e.g. an MCP tool) would be useful, or whether it's worth raising as
  feedback upstream to Anthropic.
