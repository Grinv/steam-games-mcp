// Transpile every src/**/*.ts (tests + sources) to dist-tests/ as ESM,
// preserving the directory layout so relative ".js" imports resolve.
// Decoupled from the runtime: lets `node --test` run on any Node >=20
// regardless of native TS type-stripping support.
import { build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const OUT_DIR = "dist-tests";

// esbuild's outdir only ever ADDS/overwrites files for the entry points it's
// given — it never removes stale output. Renaming or deleting a source file
// (e.g. src/__tests__/foo.test.ts) left its old compiled dist-tests/foo.test.js
// behind, so `node --test dist-tests` kept running it alongside the new files
// under its replacement name — silently double-counting (or re-running removed)
// tests. Clean the whole dir first so dist-tests always mirrors src/ exactly.
rmSync(OUT_DIR, { recursive: true, force: true });

/** @returns {string[]} all .ts files under dir (recursive) */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

await build({
  entryPoints: collect(SRC),
  outdir: OUT_DIR,
  outbase: SRC,
  bundle: false,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
});
