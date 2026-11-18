import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../lib/errors.ts";
import { callScope, optional } from "../lib/call.ts";
import { createLogger, type LogLevel } from "../lib/logger.ts";
import { PROBLEM_META_KEY, STALE_META_KEY, jsonResult, type Problem } from "../lib/result.ts";
import { toolOutput, type CallContext } from "../tools/guard.ts";

const ctx = (signal = new AbortController().signal) => ({ mcpReq: { signal } }) as CallContext;

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
    }, ctx());
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
    }, ctx());
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
    }, ctx());
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /^Internal error/);
  } finally {
    restore();
  }
});

test("a stale-cache fallback is told to the model in notes, flagged in _meta, and logged", async () => {
  const { out, lines, restore } = setup();
  try {
    const r = await out.reply(async () => {
      // What lib/http.ts does when it answers a failed request from cache.
      callScope.getStore()?.stale.push({
        err: new ApiError({ code: "server_error", status: 503, message: "HTTP 503" }),
        storedAt: Date.UTC(2026, 10, 16, 14, 3),
      });
      return { v: 1 };
    }, ctx());
    assert.equal(r.isError, undefined);
    const sc = r.structuredContent as { v: number; notes: string[] };
    assert.equal(sc.v, 1);
    assert.equal(sc.notes.length, 1);
    assert.match(
      sc.notes[0]!,
      /cached copy from 2026-11-16T14:03:00\.000Z.*returned an error \(503\)/,
    );
    assert.deepEqual(JSON.parse(r.content[0]!.text), sc); // the text mirror says the same
    assert.equal((r._meta as Record<string, unknown>)[STALE_META_KEY], true);
    assert.ok(
      lines.some(
        (l) =>
          l.level === "warn" &&
          /^served stale cache data after server_error 503: HTTP 503$/.test(l.text),
      ),
    );

    // A complete, fresh answer carries neither.
    const fresh = await out.guard(async () => jsonResult({ v: 2 }), ctx());
    assert.equal(fresh._meta, undefined);
    assert.equal("notes" in (fresh.structuredContent ?? {}), false);
  } finally {
    restore();
  }
});

test("an optional part Steam failed to provide becomes undefined plus a note; a bug propagates", async () => {
  const { out, lines, restore } = setup();
  try {
    const r = await out.reply(async () => {
      const level = await optional(
        "Steam level",
        Promise.reject(new ApiError({ code: "rate_limited", status: 429, message: "HTTP 429" })),
      );
      return { level: level ?? null };
    }, ctx());
    const sc = r.structuredContent as { level: null; notes: string[] };
    assert.equal(sc.level, null);
    assert.match(sc.notes[0]!, /^Steam level unavailable: .*rate-limiting.*\(429\)/);
    assert.ok(lines.some((l) => l.level === "warn" && /Steam level unavailable/.test(l.text)));

    const bug = await out.reply(async () => {
      await optional("Steam level", Promise.reject(new TypeError("boom")));
      return {};
    }, ctx());
    assert.match(bug.content[0]!.text, /^Internal error/);
  } finally {
    restore();
  }
});

test("two parts missing alike are two gaps in the notes, not one", async () => {
  const { out, restore } = setup();
  try {
    const fail = () =>
      optional(
        "Prices of 100 appids",
        Promise.reject(new ApiError({ code: "rate_limited", status: 429, message: "HTTP 429" })),
      );
    const r = await out.reply(async () => {
      await Promise.all([fail(), fail()]);
      return {};
    }, ctx());
    const { notes } = r.structuredContent as { notes: string[] };
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /^2× Prices of 100 appids unavailable:/);
  } finally {
    restore();
  }
});

test("a failed call is logged, with the gaps met before it failed", async () => {
  const { out, lines, restore } = setup();
  try {
    await out.guard(async () => {
      await optional(
        "Names",
        Promise.reject(new ApiError({ code: "rate_limited", status: 429, message: "slow" })),
      );
      throw new ApiError({ code: "server_error", status: 503, message: "down" });
    }, ctx());
    const warned = lines.filter((l) => l.level === "warn").map((l) => l.text);
    assert.deepEqual(warned, [
      "partial answer, Names unavailable: rate_limited 429: slow",
      "tool call failed: server_error 503: down",
    ]);
  } finally {
    restore();
  }
});
