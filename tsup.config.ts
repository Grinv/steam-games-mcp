import { defineConfig } from "tsup";

// Produces a single self-contained ESM bundle at dist/index.js with all
// dependencies inlined, so the .mcpb bundle (and npx) need no node_modules.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  bundle: true,
  // tsup leaves anything in `dependencies` external by default — which would
  // make dist/index.js require node_modules at runtime and break the .mcpb
  // (it ships none). Force every runtime dep inline so the bundle is truly
  // self-contained. Keep this list in sync with package.json "dependencies".
  noExternal: [/@modelcontextprotocol\/sdk/, /^zod($|\/)/],
  splitting: false,
  // No sourcemap: this is a distributed executable server, not a debugged
  // library; the .mcpb excludes .map anyway, and it keeps the npm tarball lean.
  sourcemap: false,
  clean: true,
  // No .d.ts: this is an executable MCP server, not a consumed library.
  dts: false,
  // Minify to shrink the shipped bundle (npm + .mcpb). We log err.message, not
  // raw stack traces, so readability of our diagnostics is unaffected.
  minify: true,
  banner: { js: "#!/usr/bin/env node" },
  // Keep dist/index.js (not .mjs) so manifest entry_point and bin resolve.
  outExtension: () => ({ js: ".js" }),
});
