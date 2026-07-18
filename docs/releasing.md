# Releasing

`package.json` is the **single source of truth** for the version. The npm
`version` lifecycle hook runs `scripts/sync-version.mjs`, which propagates it to
`src/version.ts`, `manifest.json` and `server.json` (incl. the `.mcpb` release-asset
URL); `version.test.ts` guards that they never drift. So a release is:

```sh
# 1. land your changes; move CHANGELOG.md's [Unreleased] notes under a new
#    [X.Y.Z] - YYYY-MM-DD heading and commit.
npm version <patch|minor|major>   # bumps + syncs every file + commits "release: vX.Y.Z" + tags vX.Y.Z
git push --follow-tags            # pushing the tag triggers .github/workflows/release.yml
```

The tag push (`v*`) runs the **Release** workflow: `check:api` gate → build → test
→ pack `.mcpb` → GitHub Release → `npm publish` (OIDC trusted publishing, with
provenance — no token) → **publish to the official MCP Registry** (`mcp-publisher`,
GitHub OIDC). Never hand-edit the version in the derived files; bump `package.json`
via `npm version` and let the hook sync the rest.

`release.yml` runs `check:api` with no `STEAM_API_KEY` secret configured, so its
key-gated checks always skip there — only the keyless Storefront/Web API checks
actually gate CI. Before tagging, run `STEAM_API_KEY=... npm run check:api`
locally with your own key to also exercise the key-gated player endpoints
(`GetOwnedGames`, `GetFriendList`, `GetPlayerBans`, `ResolveVanityURL`,
`GetSchemaForGame`, …) against live Steam.

## MCP Registry

The server is listed at `registry.modelcontextprotocol.io` as
`io.github.Grinv/steam-games-mcp` (`server.json`), exposing **both** packages:
the npm package (`steam-games-mcp`, run via `npx`) and the `.mcpb` GitHub-release
bundle. Ownership is verified per package type:

- **npm** → the `mcpName` field in `package.json` must equal `server.json`'s `name`
  (guarded by `version.test.ts`). It ships in the published package, so it is
  set once and every release just works.
- **mcpb** → `server.json` needs the artifact's `fileSha256`. Because `.mcpb`
  (a zip) isn't byte-reproducible, the release workflow recomputes it from the
  just-packed bundle and injects it before `mcp-publisher publish` — the committed
  value is only a placeholder. The asset URL must contain "mcp" (it does).

The namespace `io.github.Grinv/*` is authorized by GitHub OIDC from this repo, so
no registry token/secret is needed. To publish manually instead:
`mcp-publisher login github && mcp-publisher publish`.

**Keep config in three places in sync.** A user-facing env var is declared in
`config.ts` (the source of truth), `manifest.json` `user_config` (the `.mcpb`
install form), and `server.json` `packages[].environmentVariables` (the registry
entry). When you add/rename/remove one in `config.ts`, update the other two —
`version.test.ts` guards that `manifest.json` and `server.json` agree, but it
can't see `config.ts`, so the `config.ts` → descriptors step is on you. Keep
`server.json` descriptions ≤ 100 chars (registry schema cap). Purely internal
tunables (timeouts, cache, rate limits, `LOG_LEVEL`) stay env-only — they don't
belong in the install form or registry entry.
