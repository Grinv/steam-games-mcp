import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../lib/rateLimit.js";

// Small windows keep the test fast while exercising the real timing logic.
async function timeAcquires(limiter: RateLimiter, n: number): Promise<number[]> {
  const start = Date.now();
  const stamps: number[] = [];
  for (let i = 0; i < n; i += 1) {
    await limiter.acquire();
    stamps.push(Date.now() - start);
  }
  return stamps;
}

test("no rules and zero interval imposes no delay", async () => {
  const stamps = await timeAcquires(new RateLimiter(0), 5);
  assert.ok(stamps[4]! < 30, `expected near-instant, got ${stamps[4]}ms`);
});

test("min interval spaces consecutive acquisitions", async () => {
  const stamps = await timeAcquires(new RateLimiter(40), 3);
  assert.ok(stamps[1]! >= 35, `2nd should wait ~40ms, got ${stamps[1]}ms`);
  assert.ok(stamps[2]! >= 75, `3rd should wait ~80ms, got ${stamps[2]}ms`);
});

test("a sliding window caps a burst beyond its limit", async () => {
  // Allow 3 per 100ms window, no min interval: the 4th must wait for the
  // first to fall out of the window (~100ms).
  const limiter = new RateLimiter(0, [{ limit: 3, windowMs: 100 }]);
  const stamps = await timeAcquires(limiter, 4);
  assert.ok(stamps[2]! < 30, `first 3 should burst, got ${stamps[2]}ms`);
  assert.ok(stamps[3]! >= 90, `4th should wait for the window, got ${stamps[3]}ms`);
});
