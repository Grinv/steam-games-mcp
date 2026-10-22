// Cross-platform test runner: runs `node --test` straight on src/**/*.test.ts
// (Node's built-in type stripping, on by default since 22.18 — no compile
// step) with the working directory set to src/. Avoids the POSIX-only
// `(cd dir && ...)` shell idiom so it works on Windows cmd.exe too.
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

// Keep this in sync with the CI "Coverage gate" step (.github/workflows/ci.yml).
const COVERAGE_LINES_THRESHOLD = 80;

// Anything besides --coverage is forwarded to `node --test` in its original
// order, e.g. `npm test -- --test-name-pattern wishlist` to filter by name, or
// `npm test -- src/__tests__/cache.test.ts` to run only the given files (any
// `.ts` argument, resolved against the caller's cwd), which replace the
// default glob.
const rawArgs = process.argv.slice(2);
const coverage = rawArgs.includes("--coverage");
const passthrough = rawArgs
  .filter((a) => a !== "--coverage")
  .map((a) => (a.endsWith(".ts") ? resolve(a) : a));
const hasFiles = passthrough.some((a) => a.endsWith(".ts"));

// Our own flags go first — Node treats any flag after a positional file
// argument as an argument for the test files, so coverage would silently
// switch off if it came after one.
const args = ["--test"];
if (coverage) {
  args.push(
    "--experimental-test-coverage",
    // Measure the sources, not the tests themselves (which run ~100% by
    // definition and would inflate the gate).
    "--test-coverage-exclude=__tests__/**",
  );
  // The gate is for the full suite; a subset of files leaves most of src/
  // unexercised and would fail it even though every test passed.
  if (!hasFiles) args.push(`--test-coverage-lines=${COVERAGE_LINES_THRESHOLD}`);
}
args.push(...passthrough);
// Explicit glob: Node 22's default --test patterns skip .ts files.
if (!hasFiles) args.push("**/*.test.ts");

// Resolved from this script, not the caller's cwd, so it runs from anywhere.
const cwd = join(import.meta.dirname, "..", "src");
const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
child.on("error", (err) => {
  console.error(`run-tests: could not start node --test: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  // Re-raise a signal (OOM kill, CI cancel) instead of masking it as exit 1.
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
