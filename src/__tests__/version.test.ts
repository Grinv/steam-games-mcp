import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.js";

// Tests run from the dist-tests/ working directory; package.json is one level up.
const pkg = JSON.parse(readFileSync(join(process.cwd(), "..", "package.json"), "utf8")) as {
  version: string;
};

test("VERSION constant matches package.json", () => {
  assert.equal(VERSION, pkg.version);
});
