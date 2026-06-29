// Transpile every src/**/*.ts (tests + sources) to dist-tests/ as ESM,
// preserving the directory layout so relative ".js" imports resolve.
// Decoupled from the runtime: lets `node --test` run on any Node >=18
// regardless of native TS type-stripping support.
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";

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
  outdir: "dist-tests",
  outbase: SRC,
  bundle: false,
  format: "esm",
  platform: "node",
  target: "node18",
  sourcemap: true,
});
