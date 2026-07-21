import { describe, test } from "node:test";
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

describe("redact", () => {
  test("removes bearer tokens and credential params", () => {
    assert.equal(redact("Authorization: Bearer abc.def-123=="), "Authorization: Bearer ***");
    assert.match(redact("grant&refresh_token=SECRET&x=1"), /refresh_token=\*\*\*/);
    assert.ok(!redact("client_secret=zzz999").includes("zzz999"));
    assert.ok(!redact("access_token=TOK").includes("TOK"));
    // The Steam Web API key rides as a `key` query param in logged URLs.
    const url = redact("https://api.steampowered.com/x?key=DEADBEEFKEY&steamid=1");
    assert.ok(!url.includes("DEADBEEFKEY"));
    assert.match(url, /key=\*\*\*/);
    assert.match(url, /steamid=1/); // other params survive
  });

  test("catches apikey/api_key spellings, not just the bare `key` param", () => {
    // Regression: a plain `\bkey=` alone doesn't match `apikey=`/`api_key=` —
    // no word boundary sits between the preceding word characters and `key`.
    assert.ok(!redact("https://example.test/x?apikey=SECRET1").includes("SECRET1"));
    assert.match(redact("apikey=SECRET1"), /apikey=\*\*\*/);
    assert.ok(!redact("https://example.test/x?api_key=SECRET2").includes("SECRET2"));
    assert.match(redact("api_key=SECRET2"), /api_key=\*\*\*/);
  });
});
