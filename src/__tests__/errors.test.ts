import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStatus, redact } from "../lib/errors.js";

test("classifyStatus maps HTTP codes to error codes and retryability", () => {
  assert.equal(classifyStatus(401).code, "unauthorized");
  assert.equal(classifyStatus(401).retryable, false);
  assert.equal(classifyStatus(403).code, "forbidden");
  assert.equal(classifyStatus(404).code, "not_found");
  assert.equal(classifyStatus(304).code, "not_modified");
  assert.equal(classifyStatus(405).code, "bad_request");
  assert.equal(classifyStatus(422).code, "bad_request");
  assert.equal(classifyStatus(429).code, "rate_limited");
  assert.equal(classifyStatus(429).retryable, true);
  assert.equal(classifyStatus(503).code, "server_error");
  assert.equal(classifyStatus(503).retryable, true);
});

test("redact removes bearer tokens and credential params", () => {
  assert.equal(redact("Authorization: Bearer abc.def-123=="), "Authorization: Bearer ***");
  assert.match(redact("grant&refresh_token=SECRET&x=1"), /refresh_token=\*\*\*/);
  assert.ok(!redact("client_secret=zzz999").includes("zzz999"));
  assert.ok(!redact("access_token=TOK").includes("TOK"));
});
