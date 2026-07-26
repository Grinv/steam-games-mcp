// @ts-check
// Wired into the npm `preversion` lifecycle hook (see package.json) — runs
// before `npm version <bump>` touches anything. This is a presence-only
// safety net for "did we completely forget," NOT a substitute for actually
// applying the `changelog-style` skill — a script can check that
// CHANGELOG.md's [Unreleased] section isn't empty, but not that its entries
// are short/style-compliant/technical-detail-free/linked to commits (the
// skill's actual job). The skill still needs to be run by an agent as a
// real judgment step before releasing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function checkChangelog() {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const match = changelog.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/);
  const body = (match?.[1] ?? "").trim();
  const hasBullets = /^-\s/m.test(body);
  if (hasBullets) {
    console.log("preversion-check: CHANGELOG.md's [Unreleased] section has entries — OK.");
    return;
  }
  if (process.env.CONFIRM_EMPTY_CHANGELOG === "1") {
    console.log(
      "preversion-check: [Unreleased] is empty, but CONFIRM_EMPTY_CHANGELOG=1 was set — " +
        "proceeding (expected for a dependency-only/no-user-facing-change release).",
    );
    return;
  }
  console.error(
    "preversion-check: CHANGELOG.md's [Unreleased] section is empty.\n" +
      "Run the `changelog-style` skill against the commits since the last tag: gather them, " +
      "classify user-facing vs internal, and write short/self-describing entries linked to " +
      "their commits — this check only confirms *something* is there, not that it follows " +
      "that style.\n" +
      "If this release genuinely has no user-facing changes (e.g. a pure dependency bump), " +
      "re-run with CONFIRM_EMPTY_CHANGELOG=1 to proceed anyway.",
  );
  process.exit(1);
}

checkChangelog();
