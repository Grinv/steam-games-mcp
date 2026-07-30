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
import { join } from "node:path";
import { unreleasedHasBullets } from "./sync-version.mjs";

const root = join(import.meta.dirname, "..");

// `git ls-remote --tags` is *supposed* to also emit a peeled
// "<commit-sha>\trefs/tags/<tag>^{}" line for an annotated tag, pointing at
// the underlying commit — but GitHub's smart-HTTP response doesn't always
// include it, so parsing only the direct line compares the tag OBJECT's sha
// against a locally-dereferenced commit sha, which never match even when the
// tag is genuinely up to date. Fetching into a throwaway ref and dereferencing
// locally sidesteps that parsing entirely.
// Includes this process's pid so two concurrent `npm version` invocations
// checking the same tag never collide on the same scratch ref.
function remoteTagCommitSha(tag, root) {
  const tmpRef = `refs/tmp-preversion-check/${process.pid}-${tag}`;
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", `refs/tags/${tag}:${tmpRef}`], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    // Only a missing remote ref means "not pushed yet" — anything else
    // (network down, DNS failure, auth failure) is a real problem the
    // caller needs to know about, not silently treated the same way.
    const stderr = err.stderr ? err.stderr.toString() : "";
    if (/couldn't find remote ref/i.test(stderr)) {
      return undefined;
    }
    throw err;
  }
  try {
    return execFileSync("git", ["rev-parse", `${tmpRef}^{commit}`], { cwd: root })
      .toString()
      .trim();
  } finally {
    execFileSync("git", ["update-ref", "-d", tmpRef], { cwd: root });
  }
}

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

  const localSha = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { cwd: root })
    .toString()
    .trim();
  let remoteSha;
  try {
    remoteSha = remoteTagCommitSha(tag, root);
  } catch (err) {
    console.error(
      `preversion-check: could not verify whether git tag ${tag} is on origin ` +
        `(${err.message}) — this looks like a network/auth problem, not necessarily an ` +
        "unpushed tag. Check connectivity to origin and retry; if the tag turns out to " +
        `genuinely be unpushed, push it (git push origin ${tag}) or delete it ` +
        `(git tag -d ${tag}) if it was a mistake.`,
    );
    process.exit(1);
  }
  if (remoteSha === undefined) {
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
  if (remoteSha !== localSha) {
    console.error(
      `preversion-check: git tag ${tag} exists on origin, but the LOCAL tag points at a ` +
        `different commit (${localSha.slice(0, 7)} vs. origin's ${remoteSha.slice(0, 7)}).\n` +
        "This means the tag was moved locally (e.g. `git tag -f`) without pushing that move — " +
        "bumping the version again now would silently orphan the retagged commit. Push the " +
        `move first (git push --force origin ${tag}) or reset the local tag back to match ` +
        "origin if the move was a mistake, then retry.",
    );
    process.exit(1);
  }
  console.log(`preversion-check: git tag ${tag} matches origin — OK.`);
}

function checkChangelog() {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  let hasBullets;
  try {
    hasBullets = unreleasedHasBullets(changelog);
  } catch (err) {
    console.error(`preversion-check: ${err.message}`);
    process.exit(1);
  }
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
