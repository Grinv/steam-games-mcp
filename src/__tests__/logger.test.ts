import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, type LogLevel } from "../lib/logger.js";
import { buildServer, mcpLoggingSink } from "../server.js";
import { loadConfig } from "../config.js";
import { connectServer, silentLogger } from "./helpers.js";

/** Connect an in-memory client to a fresh server and collect logging
 *  notifications. Returns the server (so a sink can target it), the captured
 *  params, a promise that resolves on the next notification, and a teardown. */
async function connectWithLogCapture() {
  const server = buildServer(loadConfig({}), silentLogger());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });

  const received: { level: string; data: unknown; logger?: string }[] = [];
  let signal!: () => void;
  let next = new Promise<void>((r) => (signal = r));
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    received.push(n.params);
    signal();
    next = new Promise<void>((r) => (signal = r));
  });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    server,
    client,
    received,
    nextNotification: () => next,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type SinkCall = { level: Exclude<LogLevel, "silent">; message: string };

function captureStderr<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

test("sink mirrors every emitted line with its level", () => {
  const calls: SinkCall[] = [];
  captureStderr(() => {
    const log = createLogger("debug", (level, message) => calls.push({ level, message }));
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
  });
  assert.deepEqual(calls, [
    { level: "debug", message: "d" },
    { level: "info", message: "i" },
    { level: "warn", message: "w" },
    { level: "error", message: "e" },
  ]);
});

test("sink is gated by the same threshold as stderr", () => {
  const calls: SinkCall[] = [];
  captureStderr(() => {
    const log = createLogger("warn", (level, message) => calls.push({ level, message }));
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
  });
  assert.deepEqual(
    calls.map((c) => c.level),
    ["warn", "error"],
  );
});

test("silent level emits to neither stderr nor sink", () => {
  const calls: SinkCall[] = [];
  const { lines } = captureStderr(() => {
    const log = createLogger("silent", (level, message) => calls.push({ level, message }));
    log.error("e");
  });
  assert.equal(calls.length, 0);
  assert.equal(lines.length, 0);
});

test("messages reach the sink already redacted", () => {
  const calls: SinkCall[] = [];
  captureStderr(() => {
    const log = createLogger("info", (level, message) => calls.push({ level, message }));
    log.info("calling https://api.example.test/x?access_token=supersecret&v=1");
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.message, /access_token=\*\*\*/);
  assert.doesNotMatch(calls[0]!.message, /supersecret/);
});

test("a throwing sink never breaks logging", () => {
  const { lines } = captureStderr(() => {
    const log = createLogger("info", () => {
      throw new Error("sink blew up");
    });
    assert.doesNotThrow(() => log.info("still logs"));
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /still logs/);
});

test("server advertises the logging capability and accepts setLevel", async () => {
  const { client, close } = await connectServer();
  try {
    assert.ok(client.getServerCapabilities()?.logging, "logging capability advertised");
    // setLevel only resolves if the server registered the handler (it does so
    // only when the capability is declared).
    await assert.doesNotReject(client.setLoggingLevel("warning"));
  } finally {
    await close();
  }
});

test("mcpLoggingSink delivers a notifications/message with the mapped MCP level", async () => {
  const cap = await connectWithLogCapture();
  try {
    const log = createLogger("info", mcpLoggingSink(cap.server));
    captureStderr(() => log.warn("disk almost full")); // sink still fires; just mute stderr noise
    await cap.nextNotification();
    assert.equal(cap.received.length, 1);
    assert.equal(cap.received[0]!.level, "warning"); // internal warn → syslog "warning"
    assert.equal(cap.received[0]!.logger, "steam-games-mcp");
    assert.equal(cap.received[0]!.data, "disk almost full");
  } finally {
    await cap.close();
  }
});

test("a client setLevel filters lower-severity logs before they reach it", async () => {
  const cap = await connectWithLogCapture();
  try {
    await cap.client.setLoggingLevel("error"); // only error+ should arrive
    const log = createLogger("debug", mcpLoggingSink(cap.server));
    captureStderr(() => {
      log.warn("dropped by the client level");
      log.error("kept");
    });
    await cap.nextNotification();
    assert.equal(cap.received.length, 1);
    assert.equal(cap.received[0]!.data, "kept");
  } finally {
    await cap.close();
  }
});
