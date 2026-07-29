---
name: release
description: Cut a release of steam-games-mcp — draft CHANGELOG entries, check docs/metadata consistency, then bump/tag/push. Use when asked to release, cut a version, or publish a new version of this package.
---

# Releasing

`package.json` is the **single source of truth** for the version. The npm
`version` lifecycle hook runs `scripts/sync-version.mjs`, which propagates it to
`src/version.ts`, `manifest.json` and `server.json` (incl. the `.mcpb` release-asset
URL); `version.test.ts` guards that they never drift. The same script also dates
`CHANGELOG.md`'s `[Unreleased]` section into this version's own heading (and
leaves a fresh empty `[Unreleased]` above it) — don't hand-retitle it yourself,
before or after `npm version`; that manual step was forgotten twice before this
automation existed. `version.test.ts` guards this too (the newest dated heading
must match `package.json`'s version).

A `preversion` hook (`scripts/preversion-check.mjs`) runs first, with two checks:

- **Unpushed-tag race**: if the _current_ `package.json` version already has a
  local git tag, it blocks unless that tag is also on `origin` — this is the
  exact race that once orphaned a version in a sibling repo (`npm version` run
  twice within minutes, the first tag/commit never pushed, silently buried
  under the second). Push the dangling tag (`git push origin vX.Y.Z`) or
  delete it if it was a mistake (`git tag -d vX.Y.Z`), then retry.
- **Empty `[Unreleased]`**: presence-only safety net, not a substitute for
  actually running the skill below as a real judgment step. It blocks
  `npm version` if `CHANGELOG.md`'s `[Unreleased]` section is empty: run the
  `changelog-style` skill against the commits since the last tag first — it's
  what actually makes the entries short, self-describing, free of
  implementation detail, and linked to their commits; the hook only confirms
  _something_ is there, not that it follows that style. (Or re-run with
  `CONFIRM_EMPTY_CHANGELOG=1` if this release genuinely has no user-facing
  changes, e.g. a pure dependency bump.)

**When invoked as this skill**, run these as explicit steps, not optional —
don't rely on the `preversion` hook alone to catch a skipped one:

1. Invoke the `changelog-style` skill against the commits since the last tag;
   write/fix the `[Unreleased]` entries per its style rules.
2. Run the `docs-consistency-check` skill.
3. `STEAM_API_KEY=... npm run check:api` locally with your own key, to also
   exercise the key-gated player endpoints (`GetOwnedGames`, `GetFriendList`,
   `GetPlayerBans`, `ResolveVanityURL`, `GetSchemaForGame`, …) against live
   Steam — `release.yml` runs `check:api` with no `STEAM_API_KEY` secret
   configured, so its key-gated checks always skip there and only the
   keyless Storefront/Web API checks actually gate CI.
4. Commit everything from steps 1–2.
5. `npm version <patch|minor|major>` — preversion gate, then bumps + syncs
   every file + commits `"release: vX.Y.Z"` + tags `vX.Y.Z`.
6. `git push --follow-tags` — pushing the tag triggers `.github/workflows/release.yml`.

The tag push (`v*`) runs the **Release** workflow: `check:api` gate → build → test
→ pack `.mcpb` → extract `CHANGELOG.md`'s section for this version (fails loudly,
not silently, if that section is empty — the workflow's own safety net for
whatever slipped past `sync-version.mjs`/`preversion-check.mjs`) → GitHub Release
→ `npm publish` (OIDC trusted publishing, with provenance, pinned to an exact
verified-good npm version — no token; skipped without failing the job if this
version is already on npm, so a re-run after a partial failure doesn't abort) →
inject the just-packed `.mcpb`'s SHA-256 into `server.json` (fails loudly if the
injection didn't actually match a package, instead of silently leaving a stale
hash) → **publish to the official MCP Registry** (`mcp-publisher`, GitHub OIDC;
`mcp-publisher` itself is pinned to an exact version + verified SHA-256 rather
than `latest`, since this step runs with live OIDC publishing credentials).
Never hand-edit the version in the derived files; bump `package.json` via
`npm version` and let the hook sync the rest.

## Fixing a mistake before pushing

If something's wrong after `npm version` but before step 6 (e.g. a fixup commit
needs to land under the same release), it's safe to amend history and move the
tag — nothing's been pushed yet. One footgun when moving a tag:
`git tag -f <name>` **without** `-a`/`-m` silently downgrades an existing
annotated tag to a lightweight one, and `git push --follow-tags` silently skips
lightweight tags — the push reports success but the tag never leaves your
machine. Always move a tag with `git tag -f -a <name> -m "<name>"` (matching
what `npm version` itself creates), then verify before pushing:
`git cat-file -t <name>` must print `tag`, not `commit`. If you already
force-pushed a lightweight tag, push it explicitly: `git push origin <name>`.

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
