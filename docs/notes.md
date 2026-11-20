# Notes (personal, not load-bearing)

- Claude Code's `TaskCreate` tool only accepts one task per call (`subject` +
  `description`, no array/batch param). Consider whether a batch-create
  wrapper (e.g. an MCP tool) would be useful, or whether it's worth raising as
  feedback upstream to Anthropic.

- On MCP TypeScript SDK v2 (`@modelcontextprotocol/{server,client}@2.4.0`),
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
    `Float16Array`); tsdown's target follows `engines.node` on its own.

- Move `eslint.config.js` to `eslint.config.ts` once ESLint loads TS configs
  natively without `--flag unstable_native_nodejs_ts_config` (ESLint 10.13
  still needs that flag or the `jiti` dependency). It is already type-checked
  via `allowJs`/`checkJs` + `defineConfig()`, so this is cosmetic.

- Review findings left for later (2026-11-20, before 0.18.0). Each assumes a
  body Steam was never seen sending — checked live: ban fields on 5 of 5
  accounts, `achieved` on 520 of 520 achievements, `rank`/`appid` on 100 of
  100 chart rows, `discounted`/`id` on 60 of 60 featured items — and
  check:api's null walk fails on any unexpected `null`. Fix one if Steam's
  format changes, or when the code around it is touched anyway:
  - a `null` element crashes a call as an internal error where only the
    row's container is checked: a detailed-wishlist `store_item`, a
    `GetSchemaForGame` achievement, a `GetAppReviews` review, a
    `GetGamesFollowed` appid, nested card lists (`tags`, `active_discounts`);
  - an absent field read as a fact: `GetPlayerBans` fields as a clean record
    (`format/web.ts`), an achievement without `achieved` as locked
    (`format/webAchievements.ts`), a chart row without `rank` as rank 0
    (`format/charts.ts`), `votes_up ?? 0` and featured `discounted ?? false`;
  - a `get_items` row whose echoed `id` matches no asked appid leaves that
    appid `available:null` without a note; a detailed-wishlist entry without
    its own `appid` is in no note; `find_friends_who_own`'s `total_friends`
    leaves out friends without a `steamid`;
  - cosmetic notes: a bad chart row past `limit` still notes a gap; a library
    row without both `appid` and `playtime` is noted twice.
    Decided, not to change: featured requires all four sections (get_featured
    and get_specials share one cached answer, its rule is both tools' needs);
    every body rule's failure is retryable, so a stable misfit costs retries.
    Cleanup: `gamePurchaseOptionsRule` and `getGamePurchasePrice` both shape
    the same body, as do GetTagList's validate and `#tagNames`; `tagIdsFor`
    re-keys ~446 tags per call; a definitive "no schema" isn't cached, so each
    call asks Steam again; `getRecommendedGames` builds its own unnamed-rows
    error instead of `unnamedRows()`; `friendIdsOf` duplicates
    `friendIdsToEnrich`; `typeof appid` checks after `usableRows(hasAppid)`
    are dead and the output schemas still mark `appid` optional; the
    "unknown row is noted" rule lives in `usableRows`, `noteUnsettled` and the
    wishlist's `note`.
