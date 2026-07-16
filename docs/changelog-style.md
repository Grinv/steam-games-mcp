# Changelog entries: style & workflow

Entries in `CHANGELOG.md` should be short and self-describing. Style reference:
[common-changelog](https://github.com/vweevers/common-changelog). The workflow
below (how to actually produce those entries from commit history) is
synthesized from three changelog-generation agent skills:
[GoogleChromeLabs/changelog-generation-skill](https://github.com/GoogleChromeLabs/changelog-generation-skill),
[ComposioHQ/awesome-claude-skills/changelog-generator](https://github.com/ComposioHQ/awesome-claude-skills/tree/master/changelog-generator),
and glincker/changelog-generator.

## Style

- **One line** per entry — two only if it genuinely needs a "why". Common-changelog
  is stricter here ("a change should be brief and to the point, no more than
  one line long"); we allow a second line for a real rationale. Skip
  mechanism/implementation detail; that belongs in the commit message or PR
  description, not the changelog.
- **Imperative, present tense**: "Add X", "Fix Y" — not "Added X" / "Fixed Y".
- **Self-describing**: a reader skimming just the bullet — without its
  `### Added` / `### Fixed` category heading for context — should still
  understand the change and its effect.
- **Exclude dev-only/maintenance changes**: dotfile tweaks, dev-dependency
  bumps, test-only changes, pure code-style edits — these are not interesting
  to someone consuming the released package, so they don't get an entry; put
  them in the commit message instead. Exception: a refactor that could have
  user-visible side effects (behavior change, perf, a fixed edge case) still
  gets an entry describing that effect, not the refactor itself.
- **Link commits/PRs/issues**: reference the commit that made the change, and
  the PR or issue too when one exists.

**Example** (same change, two ways):

- ❌ "Runtime floor raised to Node ≥ 20 (was ≥ 18) — the upcoming SDK requires
  Node 20+. `engines`, build targets and the CI matrix are updated
  accordingly; `tsconfig.json` now targets ES2023."
- ✅ "Raise runtime floor to Node ≥ 20 (was ≥ 18)."

The first buries the one fact a reader needs under implementation detail; the
second states it and stops.

## Workflow (turning commits into a changelog section)

1. **Gather**: `git log --oneline <prev-tag>..<new-tag>` (or `<prev-tag>..HEAD`
   for `[Unreleased]`) for the full commit list in range. Read each commit's
   full message, not just the title — titles are often misleading or too
   technical to classify from alone.
2. **Classify** each commit:
   - _User-facing_ → gets an entry: changes behavior, a tool's inputs/outputs,
     config, fixes a real bug, adds/removes a capability.
   - _Internal, excluded_ → no entry, stays in the commit message only:
     dev-dependency bumps, test-only changes, pure renames/refactors with no
     behavior change, CI/tooling changes with no shipped effect, docs-about-docs.
   - _Borderline_: a refactor or internal fix that changes real behavior (e.g.
     a rate-limiter edge case, a cache-dedup bug) still gets an entry — describe
     the user-visible effect, not the refactor.
3. **Group**: commits belonging to the same logical change collapse into one
   bullet — don't enumerate every commit separately.
4. **Rewrite**: don't copy the commit title verbatim; restate the surviving
   change as one imperative, self-describing sentence per the Style rules above.
5. **Link**: append each backing commit as a short-hash link
   (`[<7-char-sha>](https://github.com/<owner>/<repo>/commit/<sha>)`); if a PR
   or issue exists, link that instead/in addition. A bullet backed by several
   commits links all of them.
6. **Sort**: within a category, most impactful/complex change first.
7. **Categorize** under the Keep a Changelog headings already in use (`Added`,
   `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`) — drop a heading
   entirely if nothing survives filtering for it (no more `### Internal`).

## Syncing GitHub Releases

After editing a past version's section in `CHANGELOG.md`, sync the matching
GitHub Release so it doesn't drift:
`gh release edit <tag> --notes-file <file-with-just-that-version's-body>`.
