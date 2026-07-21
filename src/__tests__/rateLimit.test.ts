import { describe, test } from "node:test";
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

describe("acquire()", () => {
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

  test("a min interval AND a sliding window combine — both constraints apply", async () => {
    // Real config shape: a per-call floor plus a per-second/minute window.
    // 20ms min interval + 2-per-100ms window; the 3rd acquire must wait for
    // the window even though the min interval alone would allow it sooner.
    const limiter = new RateLimiter(20, [{ limit: 2, windowMs: 100 }]);
    const stamps = await timeAcquires(limiter, 3);
    assert.ok(stamps[1]! >= 15, `2nd should honor the ~20ms min interval, got ${stamps[1]}ms`);
    assert.ok(stamps[2]! >= 90, `3rd should wait for the window, got ${stamps[2]}ms`);
  });

  test("first acquisition never waits, even when the clock starts at/near the epoch", async (t) => {
    // Regression: #delayUntilAllowed used to compare against a `#lastStart = 0`
    // sentinel, silently relying on Date.now() always being far from 0 — true
    // for any real clock, but not for one mocked to start at 0. Mock only Date
    // (not setTimeout) and measure REAL elapsed time via performance.now()
    // (unaffected by the Date mock): if the bug were back, the first acquire()
    // would await a genuine ~40ms setTimeout, which this would catch.
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const limiter = new RateLimiter(40);
    const realStart = performance.now();
    await limiter.acquire();
    const realElapsed = performance.now() - realStart;
    assert.ok(realElapsed < 20, `first acquisition should not really wait, took ${realElapsed}ms`);
  });
});
