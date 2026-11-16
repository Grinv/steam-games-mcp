import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../lib/errors.ts";
import { TtlCache } from "../lib/cache.ts";
import { createLogger, type LogLevel } from "../lib/logger.ts";
import { PROBLEM_META_KEY, STALE_META_KEY, jsonResult, type Problem } from "../lib/result.ts";
import { toolOutput } from "../tools/guard.ts";

function setup() {
  const lines: { level: Exclude<LogLevel, "silent">; text: string }[] = [];
  const original = console.error;
  console.error = () => {};
  const out = toolOutput(createLogger("debug", (level, text) => lines.push({ level, text })));
  return { out, lines, restore: () => (console.error = original) };
}

test("guard converts an ApiError into its problem: text for the model, Problem in _meta", async () => {
  const { out, restore } = setup();
  try {
    const r = await out.guard(() => {
      throw new ApiError({ code: "not_found", message: "diag", detail: "No app 5." });
    });
    assert.equal(r.isError, true);
    assert.equal(r.content[0]!.text, "No matching resource was found. No app 5.");
    const p = (r._meta as Record<string, Problem>)[PROBLEM_META_KEY]!;
    assert.equal(p.detail, r.content[0]!.text);
  } finally {
    restore();
  }
});

test("guard hides an unexpected error's internals from the agent and logs them", async () => {
  const { out, lines, restore } = setup();
  try {
    const r = await out.guard(() => {
      throw new Error("fetch failed: https://api.steampowered.com/x?key=DEADBEEF&steamid=1");
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /^Internal error in steam-games-mcp/);
    assert.doesNotMatch(r.content[0]!.text, /fetch failed|DEADBEEF/);
    const logged = lines.find((l) => l.level === "error")!;
    assert.match(logged.text, /fetch failed/);
    assert.doesNotMatch(logged.text, /DEADBEEF/); // the log is redacted too
  } finally {
    restore();
  }
});

test("guard converts a thrown non-Error value without crashing", async () => {
  const { out, restore } = setup();
  try {
    const r = await out.guard(() => {
      throw "just a string";
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /^Internal error/);
  } finally {
    restore();
  }
});

test("a stale-cache fallback during the call flags _meta and logs the upstream failure", async () => {
  const { out, lines, restore } = setup();
  try {
    const cache = new TtlCache(1); // 1 ms TTL: the entry is stale by the second read
    await cache.wrapStaleOnError("k", async () => ({ v: 1 }));
    await new Promise((r) => setTimeout(r, 5));
    const r = await out.reply(async () =>
      cache.wrapStaleOnError("k", async () => {
        throw new ApiError({ code: "server_error", status: 503, message: "HTTP 503" });
      }),
    );
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.structuredContent, { v: 1 });
    assert.equal((r._meta as Record<string, unknown>)[STALE_META_KEY], true);
    assert.ok(
      lines.some((l) => l.level === "warn" && /stale cache data after:.*HTTP 503/s.test(l.text)),
    );

    // A fresh answer carries no flag.
    const fresh = await out.guard(async () => jsonResult({ v: 2 }));
    assert.equal(fresh._meta, undefined);
  } finally {
    restore();
  }
});
