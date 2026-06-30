// Cross-platform test runner: runs `node --test` with the working directory set
// to dist-tests (where compiled *.test.js + their imports live). Avoids the
// POSIX-only `(cd dir && ...)` shell idiom so it works on Windows cmd.exe too.
import { spawn } from "node:child_process";

// Keep this in sync with the CI "Coverage gate" step (.github/workflows/ci.yml).
const COVERAGE_LINES_THRESHOLD = 80;

const coverage = process.argv.includes("--coverage");

// `--test-coverage-lines` (a hard, fail-the-run threshold) landed in Node 22.8.
// On older runtimes — including the Node 18 floor — fall back to reporting
// coverage without enforcing it, so `npm run test:coverage` still works there.
const [major, minor] = process.versions.node.split(".").map(Number);
const supportsThreshold = major > 22 || (major === 22 && minor >= 8);

const args = ["--test"];
if (coverage) {
  args.push("--experimental-test-coverage");
  if (supportsThreshold) args.push(`--test-coverage-lines=${COVERAGE_LINES_THRESHOLD}`);
}

const child = spawn(process.execPath, args, { cwd: "dist-tests", stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
