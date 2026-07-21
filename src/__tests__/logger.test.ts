import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, type LogLevel } from "../lib/logger.js";
import { connectServer } from "./helpers.js";

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

describe("createLogger", () => {
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
});

test("server advertises no logging capability — logging is stderr-only (SEP-2577)", async () => {
  // Regression: `capabilities.logging` + `sendLoggingMessage`/`logging/setLevel`
  // are deprecated as of protocol 2026-07-28 (SEP-2577) in favor of stderr
  // logging for stdio servers, which lib/logger.ts already provides. We
  // deliberately don't declare the capability or push notifications/message.
  const { client, close } = await connectServer();
  try {
    assert.equal(client.getServerCapabilities()?.logging, undefined);
  } finally {
    await close();
  }
});
