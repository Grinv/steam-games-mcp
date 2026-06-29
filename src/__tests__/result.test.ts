import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, type ApiErrorCode } from "../lib/errors.js";
import { apiErrorToResult, errorResult, jsonResult } from "../lib/result.js";

test("jsonResult carries both text and structuredContent", () => {
  const r = jsonResult({ a: 1 });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent, { a: 1 });
  assert.match(r.content[0]!.text, /"a":1/); // compact, no pretty-print whitespace
});

test("errorResult sets content and isError flag", () => {
  const e = errorResult("bad");
  assert.equal(e.isError, true);
  assert.equal(e.content[0]!.text, "bad");
});

test("apiErrorToResult produces an actionable message per error code", () => {
  const cases: [ApiErrorCode, RegExp][] = [
    ["unauthorized", /expired|credentials/i],
    ["forbidden", /denied access/i],
    ["not_found", /no matching resource|404/i],
    ["not_modified", /not changed|304/i],
    ["rate_limited", /rate limit/i],
    ["server_error", /5xx|retry later/i],
    ["network", /network/i],
    ["timeout", /timed out/i],
    ["bad_request", /invalid/i],
    ["unknown", /unexpected/i],
  ];
  for (const [code, re] of cases) {
    const r = apiErrorToResult(new ApiError({ code, message: "detail" }));
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, re);
  }
});
