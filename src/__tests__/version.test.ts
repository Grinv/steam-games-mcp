import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.js";

// Tests run from the dist-tests/ working directory; the repo root is one level up.
const root = join(process.cwd(), "..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(root, rel), "utf8"));

const pkg = readJson("package.json") as { version: string };
const manifest = readJson("manifest.json") as { version: string };
const server = readJson("server.json") as {
  version: string;
  packages: { version: string; identifier: string }[];
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

test("server.json version (+ package + release URL) matches package.json", () => {
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0]!.version, pkg.version);
  assert.match(server.packages[0]!.identifier, new RegExp(`/v${pkg.version}/`));
});
