import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../lib/cache.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("bounded size (max)", () => {
  test("evicts the oldest key once at capacity, keeping the newer ones", async () => {
    const cache = new TtlCache(60_000, 2);
    await cache.wrap("a", async () => 1);
    await cache.wrap("b", async () => 2);
    await cache.wrap("c", async () => 3); // over capacity → evicts "a"
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), 2);
    assert.equal(cache.get("c"), 3);
  });

  test("refreshing an existing key at capacity never evicts anything", async () => {
    const cache = new TtlCache(60_000, 2);
    await cache.wrap("a", async () => 1);
    await cache.wrap("b", async () => 2);
    // "a" already exists, so set()'s eviction check is skipped entirely for it —
    // this is FIFO-by-insertion, not LRU: refreshing "a" does not protect it
    // from a later eviction the way an LRU cache's touch would.
    await cache.wrap("a", async () => 1);
    await cache.wrap("c", async () => 3); // "a" is still the oldest insertion → evicted
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), 2);
    assert.equal(cache.get("c"), 3);
  });
});

test("get(): a value exactly at its expiry instant is already treated as expired", (t) => {
  // get() uses a strict `expires > now` check, so the boundary instant itself
  // does not count as fresh — pin the clock to prove this is stable, not
  // timing-flaky.
  const cache = new TtlCache(1000);
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  cache.set("k", "v");
  t.mock.timers.tick(1000); // now === expires exactly
  assert.equal(cache.get("k"), undefined);
  assert.equal(cache.getStale("k"), "v"); // stale fallback still sees it
});

describe("wrap", () => {
  test("caches and reuses the fresh value", async () => {
    const cache = new TtlCache(60_000);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 42;
    };
    assert.equal(await cache.wrap("k", compute), 42);
    assert.equal(await cache.wrap("k", compute), 42);
    assert.equal(calls, 1);
  });

  test("ttl <= 0 disables caching", async () => {
    const cache = new TtlCache(0);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 1;
    };
    await cache.wrap("k", compute);
    await cache.wrap("k", compute);
    assert.equal(calls, 2);
  });

  test("concurrent calls on a cold key share one in-flight compute()", async () => {
    const cache = new TtlCache(60_000);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      await tick(5);
      return 7;
    };
    // Two callers race on the same key before either resolves.
    const [a, b] = await Promise.all([cache.wrap("k", compute), cache.wrap("k", compute)]);
    assert.equal(a, 7);
    assert.equal(b, 7);
    assert.equal(calls, 1); // only one real compute(), not two
    // A later, non-concurrent call still gets the (now cached) value without recomputing.
    assert.equal(await cache.wrap("k", compute), 7);
    assert.equal(calls, 1);
  });

  test("a failed in-flight compute() clears the slot so the next call retries", async () => {
    const cache = new TtlCache(60_000);
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("boom");
    };
    await assert.rejects(() => cache.wrap("k", failing));
    await assert.rejects(() => cache.wrap("k", failing));
    assert.equal(calls, 2); // second call retried, not stuck on a resolved rejection
  });
});

describe("wrapStaleOnError", () => {
  test("serves the stale value when compute fails", async (t) => {
    // Mock Date only (not setTimeout): this just needs the TTL to have elapsed,
    // not an actual wait, so advancing the clock synchronously is both safe and
    // deterministic — no real delay, no reliance on OS timer granularity.
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const cache = new TtlCache(1); // 1ms TTL → expires almost immediately
    await cache.wrapStaleOnError("k", async () => 1);
    t.mock.timers.tick(5);
    const v = await cache.wrapStaleOnError("k", async () => {
      throw new Error("upstream down");
    });
    assert.equal(v, 1);
  });

  test("rethrows when nothing was ever cached", async () => {
    const cache = new TtlCache(60_000);
    await assert.rejects(() =>
      cache.wrapStaleOnError("missing", async () => {
        throw new Error("boom");
      }),
    );
  });

  test("concurrent calls on a cold key share one in-flight compute()", async () => {
    const cache = new TtlCache(60_000);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      await tick(5);
      return 9;
    };
    const [a, b] = await Promise.all([
      cache.wrapStaleOnError("k", compute),
      cache.wrapStaleOnError("k", compute),
    ]);
    assert.equal(a, 9);
    assert.equal(b, 9);
    assert.equal(calls, 1);
  });

  test("concurrent failures each independently fall back to the same stale value", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const cache = new TtlCache(1); // 1ms TTL → expires almost immediately
    await cache.wrapStaleOnError("k", async () => 5);
    t.mock.timers.tick(5);
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("upstream down");
    };
    const [a, b] = await Promise.all([
      cache.wrapStaleOnError("k", failing),
      cache.wrapStaleOnError("k", failing),
    ]);
    assert.equal(a, 5);
    assert.equal(b, 5);
    assert.equal(calls, 1); // shared failure, not two independent upstream hits
  });
});
