// Propagate the version from package.json (the single source of truth) into the
// other files that must carry it: src/version.ts, manifest.json (.mcpb bundle),
// server.json (MCP registry, incl. the release-asset URL), and CHANGELOG.md
// (renames [Unreleased] to this version — see renderChangelogRelease below).
// Wired into the npm `version` lifecycle hook (see package.json), so
// `npm version <bump>` updates every file in one commit — this used to be a
// manual step ("move Unreleased notes under X.Y.Z") that was easy to forget,
// or to do in the wrong order relative to `npm version` itself (a 2026-07-29
// incident shipped a v0.11.0 release commit/tag with the heading still saying
// "Unreleased," which produced an empty GitHub Release body — the release
// workflow's CHANGELOG extraction step matches `## [<version>]` verbatim).
// Uses targeted token replacement — not JSON re-serialization — to preserve
// each file's exact formatting.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function patch(rel, edits) {
  const file = join(root, rel);
  let text = readFileSync(file, "utf8");
  for (const [pattern, replacement] of edits) {
    if (!text.match(pattern)) {
      throw new Error(`sync-version: pattern ${pattern} not found in ${rel} — update the script`);
    }
    text = text.replace(pattern, replacement);
  }
  writeFileSync(file, text);
}

// The leading quote means this never matches `"manifest_version"` in manifest.json.
const versionField = /("version":\s*")[^"]*(")/;

// Move CHANGELOG.md's [Unreleased] notes under a new dated version heading,
// reopening a fresh, empty [Unreleased] above it. Pure string -> string (no
// file I/O) so it's directly unit-testable (see version.test.ts). Checks for
// an actual bullet (`- `) under [Unreleased] rather than just "is a heading
// immediately next" — robust to stray blank lines, and safe to run more than
// once (idempotent: a re-run after a failed release, or a genuinely-empty
// CONFIRM_EMPTY_CHANGELOG=1 release that preversion-check.mjs already gated,
// both find nothing to move and return the input unchanged).
export function renderChangelogRelease(text, version, date) {
  const marker = "## [Unreleased]\n";
  const idx = text.indexOf(marker);
  if (idx === -1) {
    throw new Error(`sync-version: '${marker.trim()}' heading not found in CHANGELOG.md`);
  }
  const afterMarker = text.slice(idx + marker.length);
  const bodyMatch = /^([\s\S]*?)(?=\n## \[|$)/.exec(afterMarker);
  const body = bodyMatch ? bodyMatch[1] : afterMarker;
  if (!/^-\s/m.test(body.trim())) {
    return text;
  }
  return text.slice(0, idx + marker.length) + `\n## [${version}] - ${date}\n` + afterMarker;
}

function main() {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  patch("src/version.ts", [[/(export const VERSION = ")[^"]*(")/, `$1${version}$2`]]);
  patch("manifest.json", [[versionField, `$1${version}$2`]]);
  patch("server.json", [
    [new RegExp(versionField, "g"), `$1${version}$2`], // top-level + package version
    [/(releases\/download\/v)\d+\.\d+\.\d+(\/)/, `$1${version}$2`], // .mcpb asset URL tag
  ]);

  const changelogFile = join(root, "CHANGELOG.md");
  const date = new Date().toISOString().slice(0, 10);
  const before = readFileSync(changelogFile, "utf8");
  const after = renderChangelogRelease(before, version, date);
  if (after === before) {
    console.log("sync-version: CHANGELOG.md's [Unreleased] has no bullets — leaving as-is");
  } else {
    writeFileSync(changelogFile, after);
    console.log(
      `sync-version: filed CHANGELOG.md's [Unreleased] entries under [${version}] - ${date}`,
    );
  }

  console.log(`sync-version: set ${version} in version.ts, manifest.json, server.json`);
}

// Only run as a script (not when version.test.ts imports renderChangelogRelease).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
