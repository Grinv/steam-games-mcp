import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, type ApiErrorCode } from "../lib/errors.ts";
import {
  PROBLEM_CODES,
  PROBLEM_META_KEY,
  jsonResult,
  ownProblem,
  problemResult,
  toProblem,
} from "../lib/result.ts";
import { createLogger, type LogLevel } from "../lib/logger.ts";
import { silentLogger } from "./helpers.ts";

const TYPE_BASE = "https://github.com/Grinv/steam-games-mcp/blob/main/docs/errors.md#";

function capturingLogger() {
  const lines: { level: Exclude<LogLevel, "silent">; text: string }[] = [];
  const original = console.error;
  console.error = () => {};
  const logger = createLogger("debug", (level, text) => lines.push({ level, text }));
  return { logger, lines, restore: () => (console.error = original) };
}

test("jsonResult carries both text and structuredContent", () => {
  const r = jsonResult({ a: 1 });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent, { a: 1 });
  assert.match(r.content[0]!.text, /"a":1/); // compact, no pretty-print whitespace
  assert.equal("_meta" in r, false);
});

describe("toProblem", () => {
  test("gives every ApiError code its own type, title and actionable text", () => {
    const cases: [ApiErrorCode, RegExp][] = [
      ["unauthorized", /rejected the request/i],
      ["forbidden", /denied access/i],
      ["not_found", /no matching resource/i],
      ["rate_limited", /rate-limiting.*retry/i],
      ["server_error", /returned an error.*retry later/i],
      ["network", /network/i],
      ["timeout", /timed out/i],
      ["bad_request", /invalid/i],
      ["bad_response", /unusable response/i],
      ["unknown", /unexpected/i],
    ];
    for (const [code, re] of cases) {
      const p = toProblem(new ApiError({ code, message: "diag" }), silentLogger());
      assert.equal(p.type, TYPE_BASE + code);
      assert.match(p.detail, re);
      assert.ok(p.detail.startsWith(p.title), `${code}: detail opens with the title`);
    }
  });

  test("never reads the diagnostic message, but appends our own detail", () => {
    const rawBody = "<html><body><h1>Bad Gateway</h1>some CDN error page</body></html>";
    const p = toProblem(
      new ApiError({
        code: "not_found",
        status: 404,
        message: `HTTP 404: ${rawBody}`,
        detail: "No Steam app with id 5.",
      }),
      silentLogger(),
    );
    assert.doesNotMatch(p.detail, /<html>|CDN error page/i);
    assert.equal(p.detail, "No matching resource was found (404). No Steam app with id 5.");
    assert.equal(p.upstream_status, 404);
  });

  test("shows a status only when there was one (a domain not_found isn't a 404)", () => {
    const p = toProblem(
      new ApiError({ code: "not_found", message: "d", detail: "No app." }),
      silentLogger(),
    );
    assert.equal(p.detail, "No matching resource was found. No app.");
    assert.equal("upstream_status" in p, false);
  });

  test("carries retryable from the error", () => {
    const p = toProblem(
      new ApiError({ code: "rate_limited", status: 420, message: "d", retryable: true }),
      silentLogger(),
    );
    assert.equal(p.retryable, true);
    assert.match(p.detail, /\(420\)/); // whichever status Steam actually sent
  });

  test("redacts a credential that slips into a detail", () => {
    const p = toProblem(
      new ApiError({ code: "bad_request", message: "d", detail: "see https://x/?key=DEADBEEF" }),
      silentLogger(),
    );
    assert.doesNotMatch(p.detail, /DEADBEEF/);
  });

  test("401/403 never blame the key: a rejected key is invalid_key at the source", () => {
    for (const code of ["forbidden", "unauthorized"] as const) {
      const { detail } = toProblem(new ApiError({ code, message: "d" }), silentLogger());
      assert.match(detail, /didn't answer with its rejected-key page/i);
      assert.doesNotMatch(detail, /invalid|expired|check the configured/i);
    }
  });

  test("an unexpected (non-ApiError) failure is logged in full, hidden from the agent", () => {
    const { logger, lines, restore } = capturingLogger();
    try {
      const err = new TypeError("Cannot read properties of undefined", {
        cause: new Error("root cause"),
      });
      const p = toProblem(err, logger);
      assert.equal(p.type, TYPE_BASE + "internal");
      assert.doesNotMatch(p.detail, /Cannot read|root cause/);
      assert.match(p.detail, /server log/);
      assert.equal(p.retryable, false);
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.level, "error");
      assert.match(lines[0]!.text, /TypeError: Cannot read properties/);
      assert.match(lines[0]!.text, /caused by: Error: root cause/);
    } finally {
      restore();
    }
  });
});

test("ownProblem uses its own detail, or the type's title and advice", () => {
  const p = ownProblem("not_configured", "Set STEAM_API_KEY.");
  assert.equal(p.type, TYPE_BASE + "not_configured");
  assert.equal(p.detail, "Set STEAM_API_KEY.");
  assert.match(ownProblem("internal").detail, /^Internal error in steam-games-mcp\. Details/);
});

test("problemResult puts the detail in content and the Problem in _meta", () => {
  const p = ownProblem("not_configured", "Set it.");
  const r = problemResult(p);
  assert.equal(r.isError, true);
  assert.equal(r.content[0]!.text, "Set it.");
  assert.deepEqual(r._meta, { [PROBLEM_META_KEY]: p });
  assert.equal(r.structuredContent, undefined); // reserved for outputSchema data
});

// Each problem's `type` URI points at docs/errors.md#<code>; a code without a
// section would be a dead link, a section without a code dead documentation.
test("docs/errors.md has a section for exactly every problem type", () => {
  const doc = readFileSync(join(import.meta.dirname, "../../docs/errors.md"), "utf8");
  const sections = [...doc.matchAll(/^## (\S+)$/gm)].map((m) => m[1]!);
  assert.deepEqual(sections.sort(), [...PROBLEM_CODES].sort());
});
