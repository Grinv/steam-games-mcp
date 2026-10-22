// Cross-platform test runner: runs `node --test` straight on src/**/*.test.ts
// (Node's built-in type stripping, on by default since 22.18 — no compile
// step) with the working directory set to src/. Avoids the POSIX-only
// `(cd dir && ...)` shell idiom so it works on Windows cmd.exe too.
import { spawn } from "node:child_process";

// Keep this in sync with the CI "Coverage gate" step (.github/workflows/ci.yml).
const COVERAGE_LINES_THRESHOLD = 80;

// Anything besides --coverage is forwarded as-is to `node --test`, e.g.
// `npm test -- --test-name-pattern=wishlist` to run a subset locally.
const rawArgs = process.argv.slice(2);
const coverage = rawArgs.includes("--coverage");
const passthrough = rawArgs.filter((a) => a !== "--coverage");

const args = ["--test", ...passthrough];
if (coverage) {
  args.push(
    "--experimental-test-coverage",
    `--test-coverage-lines=${COVERAGE_LINES_THRESHOLD}`,
    // Measure the sources, not the tests themselves (which run ~100% by
    // definition and would inflate the gate).
    "--test-coverage-exclude=__tests__/**",
  );
}
// Explicit glob: Node 22's default --test patterns don't include .ts files.
// Must come last — Node treats any flag after a positional file argument as
// an argument for the test files, so coverage would silently switch off.
args.push("**/*.test.ts");

const child = spawn(process.execPath, args, { cwd: "src", stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
