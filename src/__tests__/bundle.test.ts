import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The .mcpb ships dist/index.js with NO node_modules, so the tsup build MUST
// inline every runtime dependency (see tsup.config.ts `noExternal`). A dep left
// external makes the bundle crash at startup with ERR_MODULE_NOT_FOUND in any
// client that doesn't install deps for us. This guards against that regression:
// if a new dependency is added without `noExternal`, this fails.
//
// Tests run from dist-tests/; the repo root is one level up, and the tsup bundle
// is at repo/dist/index.js (built by `npm run build`, which CI runs before tests).
const root = join(process.cwd(), "..");

test("built bundle inlines all runtime dependencies (self-contained)", () => {
  const distPath = join(root, "dist", "index.js");
  if (!existsSync(distPath)) {
    // dist not built in this run (e.g. `npm test` without a prior build); CI
    // always builds first, so the check still runs there.
    return;
  }
  const bundle = readFileSync(distPath, "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const externalImport = new RegExp(`from\\s*["']${escaped}(/[^"']*)?["']`);
    assert.ok(
      !externalImport.test(bundle),
      `dist/index.js still imports "${dep}" externally — add it to tsup.config.ts noExternal`,
    );
  }
});
