---
name: docs-consistency-check
description: Check README/manifest.json/server.json/CHANGELOG.md/AGENTS.md and docs/*.md for drift against the actual registered tools and source. Use after adding, renaming, or removing a tool, or as part of a live-audit pass.
---

# Docs/metadata consistency

Check every one of these, not just a sample:

- `README.md`'s tool table matches `src/server.ts`'s registrations (names,
  and the keyless-vs-key-gated column against each tool's actual behavior).
- `manifest.json`'s and `server.json`'s `tools` arrays list the same tool
  **names** as what's actually registered (`npm test`'s `e2e.test.ts` already
  asserts this — treat a failure there as authoritative). Their `description`
  fields are deliberately short, independent marketing-style summaries, NOT a
  copy of the tool's full `.describe()`/`description` text in
  `src/tools/*.ts` — don't "fix" them to match verbatim, that's not a bug. Do
  re-read them for accuracy if a tool's _behavior_ changed in a way the short
  summary now misrepresents.
- Tool `description`/field `.describe()` text in `src/tools/*.ts` itself:
  does it still match the actual `inputSchema`/`outputSchema` and the real
  behavior? Cross-check new/edited descriptions against the
  `tool-description-check` skill (Glama's TDQS rubric) per AGENTS.md.
- `CHANGELOG.md`'s `[Unreleased]` section (see the `changelog-style` skill for
  entry style) has one line per real behavior change made in this pass — add
  missing entries, don't just flag them as missing.
- `AGENTS.md`'s "Keyless caveat" list and its `src/` tree (and this `skills/`
  entry) still match the filesystem and the actual keyless method list.
- `docs/notes.md`, `docs/clients.md` and any other `docs/*.md` for stale
  phrasing (e.g. describing something as "once published"/"upcoming" that
  already shipped).
