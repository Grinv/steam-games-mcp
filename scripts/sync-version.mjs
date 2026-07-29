// Propagate the version from package.json (the single source of truth) into the
// other files that must carry it: src/version.ts, manifest.json (.mcpb bundle),
// server.json (MCP registry, incl. the release-asset URL), and CHANGELOG.md's
// [Unreleased] heading (dated and turned into this version's own section).
// Wired into the npm `version` lifecycle hook (see package.json), so
// `npm version <bump>` updates every file in one commit. Uses targeted token
// replacement — not JSON re-serialization — to preserve each file's exact
// formatting.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

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

patch("src/version.ts", [[/(export const VERSION = ")[^"]*(")/, `$1${version}$2`]]);
patch("manifest.json", [[versionField, `$1${version}$2`]]);
patch("server.json", [
  [new RegExp(versionField, "g"), `$1${version}$2`], // top-level + package version
  [/(releases\/download\/v)\d+\.\d+\.\d+(\/)/, `$1${version}$2`], // .mcpb asset URL tag
]);

// Turn [Unreleased] into this release's own dated section (and leave a fresh
// empty [Unreleased] above it) — done here, not left as a manual release-skill
// step, so it can't be forgotten the way it twice was before this existed.
// Idempotent: skipped if [Unreleased] is already immediately followed by a
// dated version heading (e.g. a re-run of `npm version` after a failed release).
const changelogText = readFileSync(join(root, "CHANGELOG.md"), "utf8");
if (/## \[Unreleased\]\n\n## \[/.test(changelogText)) {
  console.log("sync-version: CHANGELOG.md's [Unreleased] is already dated — skipping.");
} else {
  const today = new Date().toISOString().slice(0, 10);
  patch("CHANGELOG.md", [
    [/## \[Unreleased\]\n/, `## [Unreleased]\n\n## [${version}] - ${today}\n`],
  ]);
  console.log(`sync-version: dated CHANGELOG.md's [Unreleased] section as [${version}] - ${today}`);
}

console.log(`sync-version: set ${version} in version.ts, manifest.json, server.json`);
