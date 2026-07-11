import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeItems,
  summarizeDiscover,
  summarizeWishlistDetailed,
  summarizeTagList,
} from "../format/store.js";

// Focused unit tests for the store-service card builders and their edge cases —
// discount-end resolution, availability/free handling, empty responses — that the
// server-level integration tests only touch on the happy path.

test("summarizeItems: discount_end is the SOONEST valid active-discount end", () => {
  const r = {
    response: {
      store_items: [
        {
          appid: 1,
          name: "Multi",
          best_purchase_option: {
            discount_pct: 50,
            formatted_final_price: "$5",
            // Out of order + one invalid (0) — soonest valid (1000) wins.
            active_discounts: [{ discount_end_date: 2000 }, { discount_end_date: 1000 }],
          },
        },
      ],
    },
  };
  const s = summarizeItems(r, [1]) as { items: { price: { discount_end: string } }[] };
  assert.equal(s.items[0]!.price.discount_end, "1970-01-01T00:16:40Z"); // 1000s → ISO UTC
});

test("summarizeItems: no/zero active discount → discount_end null", () => {
  const r = {
    response: {
      store_items: [
        {
          appid: 1,
          name: "ZeroEnd",
          best_purchase_option: {
            discount_pct: 0,
            formatted_final_price: "$5",
            active_discounts: [{ discount_end_date: 0 }, {}], // both filtered out
          },
        },
        { appid: 2, name: "NoDiscounts", best_purchase_option: { formatted_final_price: "$9" } },
      ],
    },
  };
  const s = summarizeItems(r, [1, 2]) as {
    items: { price: { discount_end: string | null } }[];
  };
  assert.equal(s.items[0]!.price.discount_end, null);
  assert.equal(s.items[1]!.price.discount_end, null);
});

test("summarizeItems: missing appid → available:false; free game → price {is_free}", () => {
  const r = {
    response: {
      store_items: [{ appid: 10, name: "Free Game", is_free: true }],
    },
  };
  const s = summarizeItems(r, [10, 999]) as {
    count: number;
    items: { appid: number; available?: boolean; is_free?: boolean; price?: unknown }[];
  };
  assert.equal(s.count, 2);
  const free = s.items.find((i) => i.appid === 10)!;
  assert.equal(free.is_free, true);
  assert.deepEqual(free.price, { is_free: true });
  assert.equal(s.items.find((i) => i.appid === 999)!.available, false);
});

test("summarizeDiscover: empty page returns metadata + no deals", () => {
  const s = summarizeDiscover(
    { response: { metadata: { total_matching_records: 42 }, store_items: [] } },
    {},
  ) as { total_matching: number; returned: number; deals: unknown[] };
  assert.equal(s.total_matching, 42);
  assert.equal(s.returned, 0);
  assert.deepEqual(s.deals, []);
});

test("summarizeWishlistDetailed: empty wishlist → found:false with a private/empty reason", () => {
  const s = summarizeWishlistDetailed({ response: { items: [] } }) as {
    found: boolean;
    reason: string;
    total: number;
  };
  assert.equal(s.found, false);
  assert.equal(s.total, 0);
  assert.match(s.reason, /private/i);
});

test("summarizeWishlistDetailed: keeps wishlist priority order when no discount filter", () => {
  const mk = (appid: number, priority: number) => ({
    appid,
    priority,
    store_item: { appid, name: `Game ${appid}`, best_purchase_option: { discount_pct: 0 } },
  });
  const s = summarizeWishlistDetailed({ response: { items: [mk(2, 5), mk(1, 1)] } }) as {
    matched: number;
    items: { appid: number }[];
  };
  assert.equal(s.matched, 2);
  assert.equal(s.items[0]!.appid, 1); // priority 1 sorts before priority 5
});

test("summarizeWishlistDetailed: entries Steam didn't enrich are reported via enriched/note, not silently dropped", () => {
  const mk = (appid: number) => ({
    appid,
    priority: 1,
    store_item: { appid, name: `Game ${appid}`, best_purchase_option: { discount_pct: 0 } },
  });
  // Steam attaches store_item to only the first ~100 wishlist entries; simulate
  // one enriched entry plus one bare entry (appid/priority only, no store_item).
  const s = summarizeWishlistDetailed({
    response: { items: [mk(1), { appid: 2, priority: 2 }] },
  }) as { total: number; enriched: number; matched: number; note: string | undefined };
  assert.equal(s.total, 2);
  assert.equal(s.enriched, 1);
  assert.equal(s.matched, 1);
  assert.match(s.note!, /1 of 2/);
});

test("summarizeWishlistDetailed: fully enriched wishlist carries no note", () => {
  const mk = (appid: number) => ({
    appid,
    priority: 1,
    store_item: { appid, name: `Game ${appid}`, best_purchase_option: { discount_pct: 0 } },
  });
  const s = summarizeWishlistDetailed({ response: { items: [mk(1), mk(2)] } }) as {
    enriched: number;
    note: string | undefined;
  };
  assert.equal(s.enriched, 2);
  assert.equal(s.note, undefined);
});

test("summarizeTagList maps tagid→name and skips malformed entries", () => {
  const m = summarizeTagList({
    response: {
      tags: [
        { tagid: 1, name: "Action" },
        { tagid: 2 }, // no name → skipped
        { name: "NoId" }, // no tagid → skipped
      ],
    },
  });
  assert.deepEqual(m, { 1: "Action" });
});
