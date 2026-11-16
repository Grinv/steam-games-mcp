import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../lib/cache.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("bounded size", () => {
  test("evicts the oldest entries once over the size bound, keeping the newer ones", () => {
    const cache = new TtlCache(60_000, 10);
    cache.set("a", "aaaa");
    cache.set("b", "bbbb");
    cache.set("c", "cccc"); // 12 > 10 → evicts "a"
    assert.equal(cache.getStale("a"), undefined);
    assert.equal(cache.get("b"), "bbbb");
    assert.equal(cache.get("c"), "cccc");
  });

  test("refreshing an existing key replaces its size and moves it to the back", () => {
    const cache = new TtlCache(60_000, 10);
    cache.set("a", "aaaa");
    cache.set("b", "bbbb");
    // A refresh (what wrap does once "a" expires) re-inserts it, so a key
    // refreshed every TTL — the tag dictionary — is no longer the first evicted.
    cache.set("a", "aaaa");
    assert.equal(cache.get("b"), "bbbb"); // the refresh itself evicted nothing
    cache.set("c", "cccc"); // "b" is now the oldest → evicted
    assert.equal(cache.get("a"), "aaaa");
    assert.equal(cache.getStale("b"), undefined);
    assert.equal(cache.get("c"), "cccc");
  });

  test("a value bigger than the whole bound is not cached and evicts nothing", () => {
    const cache = new TtlCache(60_000, 10);
    cache.set("a", "aaaa");
    cache.set("big", "x".repeat(11));
    assert.equal(cache.getStale("big"), undefined);
    assert.equal(cache.get("a"), "aaaa");
  });

  test("a too-big new answer for a key drops its older copy: that's no longer Steam's latest", () => {
    const cache = new TtlCache(60_000, 10);
    cache.set("a", "aaaa");
    cache.set("a", "x".repeat(11));
    assert.equal(cache.getStale("a"), undefined);
  });
});

test("ages entries on a monotonic clock: a wall clock stepped back keeps nothing fresh", async (t) => {
  // Mock only Date (setTimeout stays real): if expiry read Date.now(), stepping
  // it back an hour would keep the entry fresh for that hour.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const cache = new TtlCache(20);
  cache.set("k", "v");
  t.mock.timers.setTime(Date.now() - 3_600_000);
  await tick(30);
  assert.equal(cache.get("k"), undefined);
  assert.equal(cache.getStale("k")?.value, "v"); // stale fallback still sees it
});

describe("wrap", () => {
  test("caches and reuses the fresh value", async () => {
    const cache = new TtlCache(60_000);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return "42";
    };
    assert.equal(await cache.wrap("k", compute), "42");
    assert.equal(await cache.wrap("k", compute), "42");
    assert.equal(calls, 1);
  });

  test("ttl <= 0 disables caching", async () => {
    const cache = new TtlCache(0);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return "1";
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
      return "7";
    };
    // Two callers race on the same key before either resolves.
    const [a, b] = await Promise.all([cache.wrap("k", compute), cache.wrap("k", compute)]);
    assert.equal(a, "7");
    assert.equal(b, "7");
    assert.equal(calls, 1); // only one real compute(), not two
    // A later, non-concurrent call still gets the (now cached) value without recomputing.
    assert.equal(await cache.wrap("k", compute), "7");
    assert.equal(calls, 1);
  });

  test("a shared failure nobody waits for any more isn't an unhandled rejection", async (t) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    t.after(() => process.off("unhandledRejection", onUnhandled));
    const cache = new TtlCache(60_000);
    void cache.wrap("k", async () => {
      await tick(5);
      throw new Error("boom");
    }); // every waiter has walked away
    await tick(20);
    assert.deepEqual(unhandled, []);
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
    assert.equal(cache.getStale("k"), undefined); // a failure is never cached
  });
});
