// Propagate the version from package.json (the single source of truth) into the
// other files that must carry it: src/version.ts, manifest.json (.mcpb bundle)
// and server.json (MCP registry, incl. the release-asset URL). Wired into the
// npm `version` lifecycle hook (see package.json), so `npm version <bump>`
// updates every file in one commit. Uses targeted token replacement — not JSON
// re-serialization — to preserve each file's exact formatting.
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

console.log(`sync-version: set ${version} in version.ts, manifest.json, server.json`);
