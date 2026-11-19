import { defineConfig } from "tsdown";

// Every package allowed into the bundle: the server's runtime code from
// devDependencies (a devDependency is inlined when imported, and nobody
// installs it), plus @modelcontextprotocol/core, which
// @modelcontextprotocol/server depends on.
export const bundledDeps = [/^@modelcontextprotocol\/(server|core)($|\/)/, /^zod($|\/)/];

// Produces a single self-contained ESM bundle at dist/index.js with all
// dependencies inlined, so the .mcpb bundle (and npx) need no node_modules —
// which is why package.json has no "dependencies" for npx to install.
// Relies on tsdown defaults: entry src/index.ts, esm, platform node, outDir
// dist, clean, no sourcemap (the .mcpb excludes .map anyway), no .d.ts (an
// executable, not a library), and a target read from package.json engines.node.
export default defineConfig({
  deps: {
    // The bundle may import nothing but Node's built-ins: a package left
    // external would crash it at startup with ERR_MODULE_NOT_FOUND, since
    // neither the .mcpb nor npx installs one.
    onlyImport: [],
    // Fail the build if anything outside bundledDeps gets inlined (e.g. a
    // new transitive dep after an SDK bump), so it gets a supply-chain look.
    onlyBundle: bundledDeps,
  },
  // Minify to shrink the shipped bundle (npm + .mcpb). A reported internal
  // error's stack still resolves to source: the build is reproducible and a
  // sourcemap doesn't move the code, so rebuilding the release tag with
  // `--sourcemap` maps its positions back (AGENTS.md, "Reading a reported
  // stack"). Keeping names instead cost ~29 KB gzipped (143 → 172 KB).
  minify: true,
  banner: { js: "#!/usr/bin/env node" },
  // Keep dist/index.js (not .mjs) so manifest entry_point and bin resolve.
  fixedExtension: false,
  failOnWarn: true,
});
