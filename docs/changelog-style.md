# Changelog entry style

Entries in `CHANGELOG.md`'s `[Unreleased]` section should be short and
self-describing. Style reference: [common-changelog](https://github.com/vweevers/common-changelog).

- **One line** per entry — two only if it genuinely needs a "why". Skip
  mechanism/implementation detail; that belongs in the commit message or PR
  description, not the changelog.
- **Imperative, present tense**: "Add X", "Fix Y" — not "Added X" / "Fixed Y".
- **Self-describing**: a reader skimming just the bullet — without its
  `### Added` / `### Fixed` category heading for context — should still
  understand the change and its effect.

**Example** (same change, two ways):

- ❌ "Runtime floor raised to Node ≥ 20 (was ≥ 18) — the upcoming SDK requires
  Node 20+. `engines`, build targets and the CI matrix are updated
  accordingly; `tsconfig.json` now targets ES2023."
- ✅ "Raise runtime floor to Node ≥ 20 (was ≥ 18)."

The first buries the one fact a reader needs under implementation detail; the
second states it and stops.
