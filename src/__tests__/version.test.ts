import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.js";
import { connectServer } from "./helpers.js";
import { renderChangelogRelease, unreleasedHasBullets } from "../../scripts/sync-version.mjs";

// Tests run from the dist-tests/ working directory; the repo root is one level up.
const root = join(process.cwd(), "..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(root, rel), "utf8"));

const pkg = readJson("package.json") as { version: string; mcpName: string };
const manifest = readJson("manifest.json") as {
  version: string;
  user_config: Record<string, unknown>;
  tools: { name: string }[];
  prompts: { name: string }[];
};
const server = readJson("server.json") as {
  name: string;
  description: string;
  version: string;
  packages: {
    registryType: string;
    version: string;
    identifier: string;
    environmentVariables?: { name: string; description: string }[];
  }[];
};

// package.json is the single source of truth; scripts/sync-version.mjs (the npm
// `version` hook) propagates it everywhere below. These assertions fail loudly
// if any file drifts — including a hand-edit that bypassed the hook.
test("VERSION constant matches package.json", () => {
  assert.equal(VERSION, pkg.version);
});

test("manifest.json version matches package.json", () => {
  assert.equal(manifest.version, pkg.version);
});

// manifest.json's `tools` array is a hand-maintained short-description list (not
// generated — tools_generated:false), so a new/removed tool can silently drift
// from what the server actually registers. This catches that at test time
// instead of at .mcpb-install time.
test("manifest.json's tools list matches every tool the server actually registers", async () => {
  await using conn = await connectServer({});
  const registered = new Set((await conn.client.listTools()).tools.map((t) => t.name));
  const declared = new Set(manifest.tools.map((t) => t.name));
  assert.deepEqual(declared, registered);
});

// AGENTS.md mandates a .describe() on every tool parameter, written for the
// calling model — this guards that convention going forward instead of relying
// on review to catch a new undocumented parameter (see the tool-description-check skill).
test("every tool parameter has a .describe() for the calling model", async () => {
  await using conn = await connectServer({});
  const { tools } = await conn.client.listTools();
  const missing: string[] = [];
  for (const tool of tools) {
    const schema = tool.inputSchema as { properties?: Record<string, { description?: string }> };
    for (const [param, paramSchema] of Object.entries(schema.properties ?? {})) {
      if (!paramSchema.description) missing.push(`${tool.name}.${param}`);
    }
  }
  assert.deepEqual(missing, [], `parameters missing a .describe(): ${missing.join(", ")}`);
});

// Same drift risk as the tools list above, for manifest.json's `prompts` array.
test("manifest.json's prompts list matches every prompt the server actually registers", async () => {
  await using conn = await connectServer({});
  const registered = new Set((await conn.client.listPrompts()).prompts.map((p) => p.name));
  const declared = new Set(manifest.prompts.map((p) => p.name));
  assert.deepEqual(declared, registered);
});

// scripts/sync-version.mjs dates CHANGELOG.md's [Unreleased] section into this
// version's own heading as part of `npm version` — this guards that it actually
// ran (a version bump with a still-undated [Unreleased] slipped through twice
// before that automation existed).
test("CHANGELOG.md's newest dated section matches package.json version", () => {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const match = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  assert.ok(match, "CHANGELOG.md has no dated version heading");
  assert.equal(match?.[1], pkg.version);
});

describe("renderChangelogRelease", () => {
  test("renames Unreleased and reopens a fresh empty section above it", () => {
    const fixture =
      "## [Unreleased]\n\n### Fixed\n\n- Something ([abc1234](https://example.com)).\n\n" +
      "## [0.9.0] - 2026-07-29\n\n### Added\n\n- Old thing.\n";

    const out = renderChangelogRelease(fixture, "0.10.0", "2026-08-01");

    assert.match(out, /## \[Unreleased\]\n\n## \[0\.10\.0\] - 2026-08-01\n/);
    assert.match(out, /## \[0\.10\.0\][\s\S]*- Something/);
    assert.match(out, /## \[0\.9\.0\] - 2026-07-29\n\n### Added\n\n- Old thing\./);
  });

  test("still files a heading (with a placeholder note) when [Unreleased] has no bullets", () => {
    // A CONFIRM_EMPTY_CHANGELOG=1 release still needs its own heading with
    // SOME content, or release.yml's fail-loud "no CHANGELOG section found"
    // guard fires on exactly the scenario that escape hatch exists to allow.
    const fixture = "## [Unreleased]\n\n## [0.9.0] - 2026-07-29\n\n### Added\n\n- Old thing.\n";
    const out = renderChangelogRelease(fixture, "0.10.0", "2026-08-01");
    assert.match(out, /## \[Unreleased\]\n\n## \[0\.10\.0\] - 2026-08-01\n/);
    assert.match(out, /## \[0\.10\.0\][\s\S]*_No user-facing changes in this release\._/);
    assert.match(out, /## \[0\.9\.0\] - 2026-07-29\n\n### Added\n\n- Old thing\./);
  });

  test("still files a heading when [Unreleased] has only blank lines before the next heading", () => {
    const fixture = "## [Unreleased]\n\n\n## [0.9.0] - 2026-07-29\n\n- Old thing.\n";
    const out = renderChangelogRelease(fixture, "0.10.0", "2026-08-01");
    assert.match(out, /## \[0\.10\.0\][\s\S]*_No user-facing changes in this release\._/);
  });

  test("is idempotent: a re-run once this version's heading already exists is a no-op", () => {
    const fixture =
      "## [Unreleased]\n\n## [0.10.0] - 2026-08-01\n\n### Fixed\n\n- Something.\n\n" +
      "## [0.9.0] - 2026-07-29\n\n### Added\n\n- Old thing.\n";
    assert.equal(renderChangelogRelease(fixture, "0.10.0", "2026-08-01"), fixture);
  });

  test("throws if the Unreleased heading is missing entirely", () => {
    assert.throws(() =>
      renderChangelogRelease("## [0.10.0] - 2026-08-01\n", "0.11.0", "2026-09-01"),
    );
  });
});

describe("unreleasedHasBullets", () => {
  test("true when [Unreleased] has a bullet", () => {
    const fixture = "## [Unreleased]\n\n### Fixed\n\n- Something.\n\n## [0.9.0] - 2026-07-29\n";
    assert.equal(unreleasedHasBullets(fixture), true);
  });

  test("false when [Unreleased] has no bullets", () => {
    const fixture = "## [Unreleased]\n\n## [0.9.0] - 2026-07-29\n\n### Added\n\n- Old thing.\n";
    assert.equal(unreleasedHasBullets(fixture), false);
  });

  test("throws if the Unreleased heading is missing entirely", () => {
    assert.throws(() => unreleasedHasBullets("## [0.10.0] - 2026-08-01\n"));
  });
});

test("server.json versions (+ mcpb release URL) match package.json", () => {
  assert.equal(server.version, pkg.version);
  for (const p of server.packages) assert.equal(p.version, pkg.version);
  // The .mcpb asset URL is version-pinned; the npm identifier is not.
  const mcpb = server.packages.find((p) => p.registryType === "mcpb");
  assert.ok(mcpb, "server.json has an mcpb package");
  assert.match(mcpb.identifier, new RegExp(`/v${pkg.version}/`));
});

// The MCP Registry verifies npm ownership by matching package.json's mcpName to
// the published server name, so these must stay identical.
test("package.json mcpName matches server.json name", () => {
  assert.equal(pkg.mcpName, server.name);
});

// The MCP Registry server.schema caps description at 100 chars (npm/manifest
// have no such limit, so server.json's may differ from package.json's).
test("server.json description fits the MCP Registry 100-char limit", () => {
  assert.ok(
    server.description.length <= 100,
    `server.json description is ${server.description.length} chars (max 100)`,
  );
});

// User-facing config is declared in both manifest.json (the .mcpb install form)
// and server.json (the registry entry). They must list the same variables, so a
// new/renamed config option can't silently land in one but not the other.
// (config.ts is the upstream source; AGENTS.md covers keeping it in sync too.)
test("server.json environmentVariables match manifest.json user_config", () => {
  const expected = new Set(Object.keys(manifest.user_config).map((k) => k.toUpperCase()));
  for (const p of server.packages) {
    const got = new Set((p.environmentVariables ?? []).map((e) => e.name));
    assert.deepEqual(
      got,
      expected,
      `package ${p.registryType} environmentVariables must match manifest user_config`,
    );
  }
  // Registry schema caps each description at 100 chars too.
  for (const p of server.packages)
    for (const e of p.environmentVariables ?? [])
      assert.ok(
        e.description.length <= 100,
        `${e.name} description is ${e.description.length} > 100`,
      );
});
