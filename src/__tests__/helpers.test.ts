import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { installFetch, jsonResponse, mockFetch } from "./helpers.ts";

// A test that builds several servers installs fetch more than once
// (degradation.test.ts); the next test must still see the real fetch.
describe("installFetch", () => {
  const real = globalThis.fetch;
  test("installed twice in one test", (t) => {
    installFetch(
      t,
      mockFetch(() => jsonResponse({ a: 1 })),
    );
    installFetch(
      t,
      mockFetch(() => jsonResponse({ b: 2 })),
    );
    assert.notEqual(globalThis.fetch, real);
  });
  test("is the real fetch again in the next test", () => {
    assert.equal(globalThis.fetch, real);
  });
});
