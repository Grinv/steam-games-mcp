import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../lib/rateLimit.ts";

// Small windows keep the test fast while exercising the real timing logic.
async function timeAcquires(limiter: RateLimiter, n: number): Promise<number[]> {
  const start = performance.now();
  const stamps: number[] = [];
  for (let i = 0; i < n; i += 1) {
    await limiter.acquire();
    stamps.push(performance.now() - start);
  }
  return stamps;
}

describe("acquire()", () => {
  test("zero interval imposes no delay", async () => {
    const stamps = await timeAcquires(new RateLimiter(0), 5);
    assert.ok(stamps[4]! < 30, `expected near-instant, got ${stamps[4]}ms`);
  });

  test("min interval spaces consecutive acquisitions", async () => {
    const stamps = await timeAcquires(new RateLimiter(40), 3);
    assert.ok(stamps[1]! >= 35, `2nd should wait ~40ms, got ${stamps[1]}ms`);
    assert.ok(stamps[2]! >= 75, `3rd should wait ~80ms, got ${stamps[2]}ms`);
  });

  test("the first acquisition never waits", async () => {
    const limiter = new RateLimiter(40);
    const start = performance.now();
    await limiter.acquire();
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 20, `first acquisition should not wait, took ${elapsed}ms`);
  });

  test("a wall clock stepped back doesn't stall the next acquisition", async (t) => {
    // Regression: spacing was measured on Date.now(), so a clock stepped back
    // an hour made the next acquire() wait an hour. Mock only Date (setTimeout
    // stays real) and step it back between two acquisitions.
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const limiter = new RateLimiter(40);
    await limiter.acquire();
    t.mock.timers.setTime(Date.now() - 3_600_000);
    const start = performance.now();
    await limiter.acquire();
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 200, `expected ~40ms, waited ${elapsed}ms`);
  });

  test("a cancelled waiter stops waiting, never takes the slot, and lets the next one in", async () => {
    // Spacing wide enough that "held up" (~2 s) and "not" (~1 s) can't be
    // confused by a slow CI runner.
    const limiter = new RateLimiter(1000);
    await limiter.acquire(); // the next acquisition must wait ~1 s
    const ac = new AbortController();
    const cancelled = limiter.acquire(ac.signal);
    const next = limiter.acquire();
    ac.abort();
    await assert.rejects(cancelled, { name: "CallCancelled" });
    const start = performance.now();
    await next;
    // Still spaced from the last real start, not from the cancelled waiter.
    assert.ok(performance.now() - start < 1500, "the next waiter wasn't held up");
  });

  test("a cancelled waiter queued behind others stops waiting at once, not at its turn", async () => {
    const limiter = new RateLimiter(1000);
    await limiter.acquire(); // each next slot is ~1 s after the previous
    const ahead = limiter.acquire(); // ~1 s
    const ac = new AbortController();
    const queued = limiter.acquire(ac.signal); // would be ~2 s
    const start = performance.now();
    ac.abort();
    await assert.rejects(queued, { name: "CallCancelled" });
    assert.ok(performance.now() - start < 500, "rejected without waiting for its turn");
    await ahead;
    const after = performance.now();
    await limiter.acquire(); // the cancelled waiter never took a slot
    // ~1 s after `ahead`'s start; the cancelled waiter's slot would make it ~2 s.
    assert.ok(performance.now() - after < 1500, "spacing counts from the last real start");
  });
});
