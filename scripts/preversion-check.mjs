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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Guards against the exact race that orphaned anilist-mcp-server's v0.1.2: two
// `npm version` runs close together with no push in between. `npm version`
// creates its tag locally immediately, so if the *current* package.json
// version already has a local tag, either it was pushed (fine, this is a
// normal second release) or it wasn't (the first run's tag/commit is about to
// be orphaned the moment this second run creates a new one on top of it).
function checkUnpushedTagRace() {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const tag = `v${version}`;
  const localTagExists =
    execFileSync("git", ["tag", "--list", tag], { cwd: root }).toString().trim() === tag;
  if (!localTagExists) {
    return; // Normal case: no tag yet for the current version.
  }

  let remoteHasTag;
  try {
    remoteHasTag = execFileSync("git", ["ls-remote", "--tags", "origin", tag], { cwd: root })
      .toString()
      .includes(`refs/tags/${tag}`);
  } catch (err) {
    console.error(
      `preversion-check: git tag ${tag} exists locally for the current package.json version, ` +
        `but checking whether it's on origin failed (${err.message}).\n` +
        `Push it first (git push origin ${tag}) or delete it deliberately (git tag -d ${tag}) ` +
        "if it was a mistake, then retry.",
    );
    process.exit(1);
  }
  if (!remoteHasTag) {
    console.error(
      `preversion-check: git tag ${tag} exists locally for the current package.json version ` +
        "but hasn't been pushed to origin.\n" +
        "Bumping the version again now would silently orphan it — this is exactly how " +
        "anilist-mcp-server's v0.1.2 was lost (two `npm version` runs six minutes apart, the " +
        `first never pushed). Push it first (git push origin ${tag}) or delete it ` +
        `deliberately (git tag -d ${tag}) if it was a mistake, then retry.`,
    );
    process.exit(1);
  }
  console.log(`preversion-check: git tag ${tag} is already on origin — OK.`);
}

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

checkUnpushedTagRace();
checkChangelog();
