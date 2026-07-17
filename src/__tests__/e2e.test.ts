import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The unit suite exercises the code via an in-memory transport against src. This
// e2e instead drives the REAL built bundle the way Claude Desktop does: a spawned
// `node dist/index.js` over stdio, run from an isolated dir with NO node_modules.
// It guards the integration boundary that earlier shipped bugs hid in — the bundle
// must start, complete the initialize handshake, register every tool, and run
// self-contained (a non-inlined dep would crash the child with ERR_MODULE_NOT_FOUND).
const distPath = join(process.cwd(), "..", "dist", "index.js");

test("e2e: built bundle runs standalone, handshakes, lists all tools, gates player tools", async (t) => {
  if (!existsSync(distPath)) {
    t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
    return;
  }

  // Copy the bundle to a dir with no node_modules: if it weren't self-contained,
  // the child would die with ERR_MODULE_NOT_FOUND and connect() would reject.
  const sandbox = join(tmpdir(), `steam-mcp-e2e-${process.pid}`);
  mkdirSync(sandbox, { recursive: true });
  copyFileSync(distPath, join(sandbox, "index.js"));
  // The bundle is ESM; ship the package.json that flags it as such, exactly as
  // the real npm/.mcpb artifact does. Without it a bare `.js` is parsed as CJS
  // on Node < 20.19 (which lacks ESM syntax auto-detection) and the child dies
  // with "Cannot use import statement outside a module".
  writeFileSync(join(sandbox, "package.json"), JSON.stringify({ type: "module" }));

  // Inherit env but force the player credentials unset, to test the key gate.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "STEAM_API_KEY" && k !== "STEAM_ID") env[k] = v;

  const client = new Client({ name: "e2e", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(sandbox, "index.js")],
    env,
  });

  try {
    await client.connect(transport); // real initialize handshake over a spawned process

    const { tools } = await client.listTools();
    assert.equal(tools.length, 24, "every tool should register in the built bundle");

    // A player tool without a key must short-circuit with the actionable message
    // (no network) — proving the key gate works through the real binary.
    const res = await client.callTool({ name: "get_owned_games", arguments: {} });
    assert.equal(res.isError, true);
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.match(text, /needs a Steam Web API key/i);
  } finally {
    await client.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
