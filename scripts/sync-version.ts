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
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

function patch(rel: string, edits: [RegExp, string][]): void {
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

// Shared with preversion-check.ts's checkChangelog(): does CHANGELOG.md's
// [Unreleased] section (everything up to the next "## [" heading) contain a
// real bullet? Checks for an actual bullet (`- `) rather than just "is a
// heading immediately next" — robust to stray blank lines. Exported so both
// scripts encode this one rule exactly once instead of two independently
// drifting regexes.
export function unreleasedHasBullets(text: string): boolean {
  const marker = "## [Unreleased]\n";
  const idx = text.indexOf(marker);
  if (idx === -1) {
    throw new Error(`sync-version: '${marker.trim()}' heading not found in CHANGELOG.md`);
  }
  const afterMarker = text.slice(idx + marker.length);
  const bodyMatch = /^([\s\S]*?)(?=\n## \[|$)/.exec(afterMarker);
  const body = bodyMatch?.[1] ?? afterMarker;
  return /^-\s/m.test(body.trim());
}

// Move CHANGELOG.md's [Unreleased] notes under a new dated version heading,
// reopening a fresh, empty [Unreleased] above it. Pure string -> string (no
// file I/O) so it's directly unit-testable (see version.test.ts). Every
// release gets its own heading — even a no-user-facing-change release
// (CONFIRM_EMPTY_CHANGELOG=1, no bullets) still needs one with SOME content,
// or release.yml's own fail-loud "no CHANGELOG section found" guard fires on
// exactly the scenario that escape hatch exists to allow. Idempotent: a
// re-run once this version's heading already exists (e.g. a second
// sync-version.ts invocation after a failed release) finds nothing left to
// do and returns the input unchanged.
export function renderChangelogRelease(text: string, version: string, date: string): string {
  if (text.includes(`## [${version}] - `)) {
    return text;
  }
  const marker = "## [Unreleased]\n";
  const idx = text.indexOf(marker);
  // unreleasedHasBullets throws the same "heading not found" error for this
  // case, so just let it propagate rather than re-deriving the check here.
  const hasBullets = unreleasedHasBullets(text);
  const afterMarker = text.slice(idx + marker.length);
  const heading = `\n## [${version}] - ${date}\n`;
  if (!hasBullets) {
    return (
      text.slice(0, idx + marker.length) +
      heading +
      "\n_No user-facing changes in this release._\n" +
      afterMarker
    );
  }
  return text.slice(0, idx + marker.length) + heading + afterMarker;
}

function main(): void {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };

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
    console.log(
      `sync-version: CHANGELOG.md already has a heading for [${version}] — leaving as-is`,
    );
  } else {
    writeFileSync(changelogFile, after);
    console.log(
      `sync-version: filed CHANGELOG.md's [Unreleased] entries under [${version}] - ${date}`,
    );
  }

  console.log(`sync-version: set ${version} in version.ts, manifest.json, server.json`);
}

// Only run as a script (not when version.test.ts imports renderChangelogRelease).
if (import.meta.main) {
  main();
}
