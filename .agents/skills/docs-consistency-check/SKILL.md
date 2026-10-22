---
name: docs-consistency-check
description: Check README/manifest.json/server.json/CHANGELOG.md/AGENTS.md and docs/*.md for drift against the actual registered tools and source. Use after adding, renaming, or removing a tool, or as part of a live-audit pass.
---

# Docs/metadata consistency

Check every one of these, not just a sample:

- `README.md`'s tool table matches `src/server.ts`'s registrations (names,
  and the keyless-vs-key-gated column against each tool's actual behavior).
- `manifest.json`'s `tools` and `prompts` arrays list the same **names** as
  what's actually registered (`server.json` has no tool list; `npm test`'s
  `version.test.ts` already asserts this — treat a failure there as
  authoritative). Their `description`
  fields are deliberately short, independent marketing-style summaries, NOT a
  copy of the tool's full `.describe()`/`description` text in
  `src/tools/*.ts` — don't "fix" them to match verbatim, that's not a bug. Do
  re-read them for accuracy if a tool's _behavior_ changed in a way the short
  summary now misrepresents — `manifest.json`'s `user_config` descriptions too
  (`steam_id` kept saying a vanity name needs the key after keyless
  resolution shipped).
- Tool `description`/field `.describe()` text in `src/tools/*.ts` itself:
  does it still match the actual `inputSchema`/`outputSchema` and the real
  behavior? Cross-check new/edited descriptions against the
  `tool-description-check` skill (Glama's TDQS rubric) per AGENTS.md. Check
  each `outputSchema` **branch** against what the shaper actually builds, not
  just the happy path — `get_owned_games`' `found:false` branch still
  advertised an `owns` field the 0.10.1 fix had stopped emitting, i.e. the
  published schema re-legitimized the very bug that was fixed.
- `CHANGELOG.md`'s `[Unreleased]` section (see the `changelog-style` skill for
  entry style) has one line per real behavior change made in this pass — add
  missing entries, don't just flag them as missing.
- `docs/architecture.md`'s "Keyless caveat" list still matches the actual
  keyless method list in `src/clients/`, and `AGENTS.md`'s `src/`/`scripts/`
  tree (and this `.agents/skills/` entry) still match the filesystem.
- `docs/notes.md`, `docs/clients.md` and any other `docs/*.md` for stale
  phrasing (e.g. describing something as "once published"/"upcoming" that
  already shipped).
- `PRIVACY.md` and `SECURITY.md`: grep `src/clients/` for every host the code
  contacts and diff it against their host lists (keyless vanity resolution
  added `steamcommunity.com` while both still said "two hosts"). Then
  re-verify every other specific claim against the
  actual current code, don't just skim for plausibility — which credentials
  exist and how each is transmitted/redacted, what is and isn't cached (incl.
  cache key/TTL), the current list of read-only vs. write/mutating tools, and
  any host-allowlist statement. This class of drift is easy to miss because
  it reads fine on its own and only breaks against the code: this repo's own
  `SECURITY.md`/`PRIVACY.md` both claimed "player-specific data is never
  cached" after a later feature (`get_player_summary`'s Steam-level cache)
  added exactly that, and a separate claim conflated an actually-cached field
  ("review histogram") with a similarly-named never-cached one ("reviews")
  — neither doc was self-evidently wrong, both required re-reading the
  client code to catch.
