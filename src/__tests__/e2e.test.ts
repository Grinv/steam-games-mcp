import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client, type CacheKey, type ResponseCacheStore } from "@modelcontextprotocol/client";
import { textOf } from "./helpers.js";
import { VERSION } from "../version.js";

// The unit suite exercises the code via an in-memory transport against src (see
// helpers.ts's connectServer()) — that only ever drives a bare McpServer, never
// the actual serveStdio() entry point src/server.ts#start() wires up. Per the SDK's
// own testing guidance, stdio has no in-process shortcut: this file is the only
// place that runs the REAL built bundle the way Claude Desktop does — a spawned
// `node dist/index.js` over stdio, run from an isolated dir with NO node_modules.
// It guards the integration boundary that earlier shipped bugs hid in — the bundle
// must start, complete the initialize handshake, register every tool, run
// self-contained (a non-inlined dep would crash the child with ERR_MODULE_NOT_FOUND),
// and shut down cleanly when signalled.
const distPath = join(process.cwd(), "..", "dist", "index.js");

// Copy the bundle to a dir with no node_modules: if it weren't self-contained,
// the child would die with ERR_MODULE_NOT_FOUND and connect() would reject.
function makeSandbox(): string {
  const sandbox = join(tmpdir(), `steam-mcp-e2e-${process.pid}-${Date.now()}`);
  mkdirSync(sandbox, { recursive: true });
  copyFileSync(distPath, join(sandbox, "index.js"));
  // The bundle is ESM; ship the package.json that flags it as such, exactly as
  // the real npm/.mcpb artifact does. Without it a bare `.js` is parsed as CJS
  // on Node < 20.19 (which lacks ESM syntax auto-detection) and the child dies
  // with "Cannot use import statement outside a module".
  writeFileSync(join(sandbox, "package.json"), JSON.stringify({ type: "module" }));
  return sandbox;
}

// Inherit env but force the player credentials unset, to test the key gate.
function envWithoutCredentials(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "STEAM_API_KEY" && k !== "STEAM_ID") env[k] = v;
  return env;
}

describe("e2e (real built bundle over stdio)", () => {
  test("runs standalone, handshakes, lists all tools, gates player tools", async (t) => {
    if (!existsSync(distPath)) {
      t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
      return;
    }

    const sandbox = makeSandbox();
    const client = new Client({ name: "e2e", version: "0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(sandbox, "index.js")],
      env: envWithoutCredentials(),
    });

    try {
      await client.connect(transport); // real initialize handshake over a spawned process

      const { tools } = await client.listTools();
      assert.equal(tools.length, 25, "every tool should register in the built bundle");

      // A player tool without a key must short-circuit with the actionable message
      // (no network) — proving the key gate works through the real binary.
      const res = await client.callTool({ name: "get_owned_games", arguments: {} });
      assert.equal(res.isError, true);
      const text = textOf(res);
      assert.match(text, /needs a Steam Web API key/i);
    } finally {
      await client.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("negotiates the modern (2026-07-28) era over real stdio (versionNegotiation: 'auto')", async (t) => {
    // The default test above connects with the SDK's default versionNegotiation
    // ('legacy'), so it never sends `server/discover` and never exercises the
    // modern-era path serveStdio implements (see server.ts's comment: the
    // factory may run once for a disposable probe sibling and again for the
    // real connection). Opting into 'auto' here is the only place that path —
    // and the serverInfo it stamps into response _meta — gets covered.
    if (!existsSync(distPath)) {
      t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
      return;
    }

    const sandbox = makeSandbox();
    const client = new Client(
      { name: "e2e-modern", version: "0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(sandbox, "index.js")],
      env: envWithoutCredentials(),
    });

    try {
      await client.connect(transport);

      const { tools } = await client.listTools();
      assert.equal(tools.length, 25, "every tool should register under the modern era too");
      assert.deepEqual(client.getServerVersion(), { name: "steam-games-mcp", version: VERSION });

      const res = await client.callTool({ name: "get_owned_games", arguments: {} });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /needs a Steam Web API key/i);
    } finally {
      await client.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  // A minimal ResponseCacheStore that just records every write, so a test can
  // inspect the ttlMs/cacheScope the client computed from the wire response
  // instead of guessing from the SDK's type declarations — the client's own
  // listTools()/listPrompts() return value doesn't expose those fields (they
  // only drive the client's internal cache), so this is the only way to
  // observe them from outside the SDK.
  function spyCacheStore() {
    const writes: { method: string; expiresAt?: number; scope?: string }[] = [];
    const store: ResponseCacheStore = {
      get: () => undefined,
      set: (key: CacheKey, entry) => {
        writes.push({ method: key.method, expiresAt: entry.expiresAt, scope: entry.scope });
        return 0;
      },
      delete: () => {},
      evict: () => {},
      clear: () => {},
    };
    return { store, writes };
  }

  test("server.ts's cacheHints give tools/list and prompts/list a 1h public hint under the modern era, and don't leak into the legacy era", async (t) => {
    if (!existsSync(distPath)) {
      t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
      return;
    }
    const HOUR_MS = 3_600_000;
    const sandbox = makeSandbox();

    try {
      // Modern era: server.ts's cacheHints should reach the client as a
      // ~1h/public hint on both list-singleton methods.
      {
        const { store, writes } = spyCacheStore();
        const client = new Client(
          { name: "e2e-cache-modern", version: "0" },
          { versionNegotiation: { mode: "auto" }, responseCacheStore: store },
        );
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [join(sandbox, "index.js")],
          env: envWithoutCredentials(),
        });
        const before = Date.now();
        try {
          await client.connect(transport);
          await client.listTools();
          await client.listPrompts();
        } finally {
          await client.close();
        }

        const toolsWrite = writes.find((w) => w.method === "tools/list");
        const promptsWrite = writes.find((w) => w.method === "prompts/list");
        assert.ok(toolsWrite, "tools/list should write a cache entry under the modern era");
        assert.equal(toolsWrite?.scope, "public");
        assert.ok(
          toolsWrite!.expiresAt! >= before + HOUR_MS - 10_000 &&
            toolsWrite!.expiresAt! <= before + HOUR_MS + 10_000,
          `tools/list's expiresAt should be ~1h out, got ${toolsWrite?.expiresAt} (before=${before})`,
        );
        assert.equal(promptsWrite?.scope, "public");
      }

      // Legacy era: the 2025 wire carries no ttlMs/cacheScope fields at all,
      // so our modern-era hint must never surface there — the client falls
      // back to its own defaultCacheTtlMs (0, "immediately stale").
      {
        const { store, writes } = spyCacheStore();
        const client = new Client(
          { name: "e2e-cache-legacy", version: "0" },
          { responseCacheStore: store },
        );
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [join(sandbox, "index.js")],
          env: envWithoutCredentials(),
        });
        const before = Date.now();
        try {
          await client.connect(transport);
          await client.listTools();
        } finally {
          await client.close();
        }

        const toolsWrite = writes.find((w) => w.method === "tools/list");
        assert.ok(
          toolsWrite,
          "tools/list should still write an entry (backs the tools/list-derived index)",
        );
        assert.notEqual(
          toolsWrite?.scope,
          "public",
          "the legacy era must never see the modern-era cache hint",
        );
        assert.ok(
          toolsWrite!.expiresAt! <= before + 1000,
          `legacy era's entry should be immediately stale, got expiresAt=${toolsWrite?.expiresAt} (before=${before})`,
        );
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  // A representative slice of protocol-level behaviors, run once per protocol
  // era (not once per tool — every tool already shares the same registration/
  // validation/error-wrapping machinery, so this checks that machinery isn't
  // era-sensitive, rather than re-testing every tool's own logic twice). Kept
  // network-free like every other e2e test here: each call either short-
  // circuits before any fetch (missing key, schema-validation rejection) or
  // never touches a client at all (a prompt, which is pure message-template
  // logic) — a live Storefront/Web API call has no place in the default
  // `npm test` gate (that's what `check:api` is for).
  async function assertRepresentativeSlice(client: Client): Promise<void> {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 25, "every tool should register");

    const { prompts } = await client.listPrompts();
    assert.equal(prompts.length, 3, "every prompt should register");

    const keyGated = await client.callTool({ name: "get_owned_games", arguments: {} });
    assert.equal(keyGated.isError, true);
    assert.match(textOf(keyGated), /needs a Steam Web API key/i);

    const badBatch = await client.callTool({ name: "get_prices", arguments: { appids: [] } });
    assert.equal(badBatch.isError, true, "an empty appids array should fail schema validation");

    const prompt = await client.getPrompt({ name: "is_it_worth_buying", arguments: {} });
    const promptText = (prompt.messages[0]!.content as { text: string }).text;
    assert.match(promptText, /which game/i);
  }

  test("the representative behavior slice above holds under both the legacy and modern era", async (t) => {
    if (!existsSync(distPath)) {
      t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
      return;
    }
    const sandbox = makeSandbox();

    try {
      for (const [label, clientOptions] of [
        ["legacy", undefined],
        ["modern", { versionNegotiation: { mode: "auto" as const } }],
      ] as const) {
        const client = new Client({ name: `e2e-slice-${label}`, version: "0" }, clientOptions);
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [join(sandbox, "index.js")],
          env: envWithoutCredentials(),
        });
        try {
          await client.connect(transport);
          await assertRepresentativeSlice(client);
        } catch (err) {
          throw new Error(`representative slice failed under the ${label} era: ${err}`, {
            cause: err,
          });
        } finally {
          await client.close();
        }
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("shuts down cleanly on SIGTERM (serveStdio's handle.close() wiring works in the real binary)", async (t) => {
    // The unit suite never exercises this: helpers.ts's connectServer() calls
    // server.close() directly on a bare McpServer, not through the serveStdio
    // handle src/server.ts#start() actually returns and wires SIGINT/SIGTERM to.
    if (!existsSync(distPath)) {
      t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
      return;
    }

    // Windows has no POSIX signals: process.kill(pid, "SIGTERM") force-terminates the
    // child directly instead of delivering anything its `process.on("SIGTERM", ...)`
    // handler could catch, so this test would pass there without ever exercising
    // server.ts's shutdown()/handle.close() path — a false-positive pass, not real
    // coverage. Skip rather than claim graceful-shutdown coverage this platform can't give.
    if (process.platform === "win32") {
      t.skip("SIGTERM isn't delivered to a signal handler on Windows — see comment above");
      return;
    }

    const sandbox = makeSandbox();
    const client = new Client({ name: "e2e-shutdown", version: "0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(sandbox, "index.js")],
      env: envWithoutCredentials(),
    });

    try {
      await client.connect(transport);
      await client.listTools(); // confirm it's actually up before signalling

      const pid = transport.pid;
      assert.ok(pid, "transport should expose the spawned child's pid once connected");

      const closed = new Promise<void>((resolve) => {
        transport.onclose = () => resolve();
      });
      process.kill(pid, "SIGTERM");

      // Race against a generous timeout so a regression (hung shutdown) fails
      // the test instead of hanging the whole suite.
      const timedOut = Symbol("timeout");
      const result = await Promise.race([
        closed.then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve(timedOut), 5000)),
      ]);
      assert.notEqual(result, timedOut, "process did not exit within 5s of SIGTERM");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
