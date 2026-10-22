// Cross-platform test runner: runs `node --test` straight on src/**/*.test.ts
// (Node's built-in type stripping, on by default since 22.18 — no compile
// step) with the working directory set to src/. Avoids the POSIX-only
// `(cd dir && ...)` shell idiom so it works on Windows cmd.exe too.
import { spawn } from "node:child_process";
import { join } from "node:path";

// Keep this in sync with the CI "Coverage gate" step (.github/workflows/ci.yml).
const COVERAGE_LINES_THRESHOLD = 80;

// Anything besides --coverage is forwarded to `node --test`: flags (use the
// `--flag=value` form) like `npm test -- --test-name-pattern=wishlist`, or
// test files relative to src/ like `npm test -- __tests__/cache.test.ts`,
// which replace the default glob.
const rawArgs = process.argv.slice(2);
const coverage = rawArgs.includes("--coverage");
const passthrough = rawArgs.filter((a) => a !== "--coverage");
const flags = passthrough.filter((a) => a.startsWith("-"));
const files = passthrough.filter((a) => !a.startsWith("-"));

const args = ["--test", ...flags];
if (coverage) {
  args.push(
    "--experimental-test-coverage",
    `--test-coverage-lines=${COVERAGE_LINES_THRESHOLD}`,
    // Measure the sources, not the tests themselves (which run ~100% by
    // definition and would inflate the gate).
    "--test-coverage-exclude=__tests__/**",
  );
}
// Files go last — Node treats any flag after a positional file argument as an
// argument for the test files, so coverage would silently switch off. The
// glob is explicit because Node 22's default --test patterns skip .ts files.
args.push(...(files.length > 0 ? files : ["**/*.test.ts"]));

// Resolved from this script, not the caller's cwd, so it runs from anywhere.
const cwd = join(import.meta.dirname, "..", "src");
const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
