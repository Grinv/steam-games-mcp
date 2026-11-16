import { defineConfig } from "tsdown";

// Every package allowed into the bundle: package.json "dependencies" plus
// @modelcontextprotocol/core, which @modelcontextprotocol/server depends on
// transitively (not a direct dependency here, but still needed at runtime).
const bundledDeps = [/^@modelcontextprotocol\/(server|core)($|\/)/, /^zod($|\/)/];

// Produces a single self-contained ESM bundle at dist/index.js with all
// dependencies inlined, so the .mcpb bundle (and npx) need no node_modules.
// Relies on tsdown defaults: entry src/index.ts, esm, platform node, outDir
// dist, clean, no sourcemap (the .mcpb excludes .map anyway), no .d.ts (an
// executable, not a library), and a target read from package.json engines.node.
export default defineConfig({
  deps: {
    // tsdown leaves anything in `dependencies` external by default — which
    // would make dist/index.js require node_modules at runtime and break the
    // .mcpb (it ships none). Force every runtime dep inline.
    alwaysBundle: bundledDeps,
    // Fail the build if anything else from node_modules gets inlined (e.g. a
    // new transitive dep after an SDK bump), so it gets a supply-chain look.
    onlyBundle: bundledDeps,
  },
  // Minify to shrink the shipped bundle (npm + .mcpb). We log err.message, not
  // raw stack traces, so readability of our diagnostics is unaffected.
  minify: true,
  banner: { js: "#!/usr/bin/env node" },
  // Keep dist/index.js (not .mjs) so manifest entry_point and bin resolve.
  fixedExtension: false,
  failOnWarn: true,
});
