import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../lib/cache.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("wrap caches and reuses the fresh value", async () => {
  const cache = new TtlCache<number>(60_000);
  let calls = 0;
  const compute = async () => {
    calls += 1;
    return 42;
  };
  assert.equal(await cache.wrap("k", compute), 42);
  assert.equal(await cache.wrap("k", compute), 42);
  assert.equal(calls, 1);
});

test("wrapStaleOnError serves the stale value when compute fails", async () => {
  const cache = new TtlCache<number>(1); // 1ms TTL → expires almost immediately
  await cache.wrapStaleOnError("k", async () => 1);
  await tick(5);
  const v = await cache.wrapStaleOnError("k", async () => {
    throw new Error("upstream down");
  });
  assert.equal(v, 1);
});

test("wrapStaleOnError rethrows when nothing was ever cached", async () => {
  const cache = new TtlCache<number>(60_000);
  await assert.rejects(() =>
    cache.wrapStaleOnError("missing", async () => {
      throw new Error("boom");
    }),
  );
});

test("ttl <= 0 disables caching", async () => {
  const cache = new TtlCache<number>(0);
  let calls = 0;
  const compute = async () => {
    calls += 1;
    return 1;
  };
  await cache.wrap("k", compute);
  await cache.wrap("k", compute);
  assert.equal(calls, 2);
});
