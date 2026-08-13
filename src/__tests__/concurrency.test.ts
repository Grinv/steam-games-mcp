// Unit tests for lib/concurrency.ts's settledWithLimit — the bounded fan-out
// behind findFriendsWhoOwn's per-friend GetOwnedGames calls.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { settledWithLimit } from "../lib/concurrency.js";

describe("settledWithLimit", () => {
  test("never runs more than `limit` tasks at once, and still runs all of them", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    const results = await settledWithLimit(items, 4, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return i * 2;
    });
    assert.equal(peak, 4);
    assert.equal(results.length, 50);
    assert.equal(inFlight, 0);
    assert.deepEqual(
      results.map((r) => (r.status === "fulfilled" ? r.value : null)),
      items.map((i) => i * 2),
    );
  });

  test("reports each rejection individually instead of failing the whole batch", async () => {
    const results = await settledWithLimit([1, 2, 3, 4], 2, async (i) => {
      if (i % 2 === 0) throw new Error(`boom ${i}`);
      return i;
    });
    assert.deepEqual(
      results.map((r) => r.status),
      ["fulfilled", "rejected", "fulfilled", "rejected"],
    );
    // Order is the INPUT order, not completion order — findFriendsWhoOwn pairs
    // results[i] with friendIds[i] positionally.
    assert.equal((results[1] as PromiseRejectedResult).reason.message, "boom 2");
    assert.equal((results[3] as PromiseRejectedResult).reason.message, "boom 4");
  });

  test("handles an empty list and a limit above the item count", async () => {
    assert.deepEqual(await settledWithLimit([], 8, async () => 1), []);
    const results = await settledWithLimit([1, 2], 99, async (i) => i);
    assert.equal(results.length, 2);
  });
});
