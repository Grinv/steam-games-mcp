// npm audit over what users actually run. The bundle inlines its runtime
// packages (tsdown.config.ts `bundledDeps`) and npm installs none of them, so
// `npm audit --omit=dev` sees nothing, while a full audit fails on dev tools
// that never ship. A finding counts when every package on its install path is
// one the bundle inlines (so a copy nested under the SDK counts too).
// Usage: npm audit --json | node scripts/audit-bundle.ts
import { text } from "node:stream/consumers";
import { bundledDeps } from "../tsdown.config.ts";

const report = JSON.parse(await text(process.stdin)) as {
  vulnerabilities?: Record<string, { severity: string; nodes: string[] }>;
};
if (!report.vulnerabilities) {
  console.error("Not an npm audit report:", JSON.stringify(report).slice(0, 300));
  process.exit(1);
}
const shipped = (path: string) =>
  path
    .split(/(?:^|\/)node_modules\//)
    .filter(Boolean)
    .every((name) => bundledDeps.some((re) => re.test(name)));
const found = Object.entries(report.vulnerabilities).filter(([, v]) => v.nodes.some(shipped));
for (const [name, v] of found)
  console.error(`${name}: ${v.severity} (${v.nodes.filter(shipped).join(", ")})`);
if (found.length) process.exit(1);
console.log("No known vulnerabilities in the bundled packages.");
