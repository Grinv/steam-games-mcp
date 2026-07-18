import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeItems,
  summarizeDiscover,
  summarizeWishlistDetailed,
  summarizeTagList,
  computeFavoriteTagWeights,
  summarizeRecommendations,
  type StoreItem,
  type TagMap,
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

test("summarizeItems: vr_support is none/supported/required depending on vrhmd/vrhmd_only", () => {
  const r = {
    response: {
      store_items: [
        { appid: 1, name: "Flatscreen Only" }, // no vr_support key at all
        { appid: 2, name: "VR Optional", platforms: { vr_support: { vrhmd: true } } },
        {
          appid: 3,
          name: "VR Exclusive",
          platforms: { vr_support: { vrhmd: true, vrhmd_only: true } },
        },
      ],
    },
  };
  const s = summarizeItems(r, [1, 2, 3]) as { items: { appid: number; vr_support: string }[] };
  assert.equal(s.items.find((i) => i.appid === 1)!.vr_support, "none");
  assert.equal(s.items.find((i) => i.appid === 2)!.vr_support, "supported");
  assert.equal(s.items.find((i) => i.appid === 3)!.vr_support, "required");
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

const RECO_TAG_MAP: TagMap = { 1: "Roguelike", 2: "Horror", 3: "Souls-like" };

test("computeFavoriteTagWeights: weights tags by hours played, ignores zero/no playtime", () => {
  const items: StoreItem[] = [
    { appid: 10, tags: [{ tagid: 1, weight: 900 }] }, // 120 min = 2h
    {
      appid: 20,
      tags: [
        { tagid: 1, weight: 500 },
        { tagid: 2, weight: 400 },
      ],
    }, // 60 min = 1h
    { appid: 30, tags: [{ tagid: 2, weight: 900 }] }, // 0 min → contributes nothing
  ];
  const playtime = new Map([
    [10, 120],
    [20, 60],
    [30, 0],
  ]);
  const weights = computeFavoriteTagWeights(items, playtime, RECO_TAG_MAP);
  assert.equal(weights.get("Roguelike"), 3); // 2h (appid 10) + 1h (appid 20)
  assert.equal(weights.get("Horror"), 1); // only appid 20's 1h; appid 30 ignored
});

test("summarizeRecommendations: excludes owned/zero-overlap candidates, ranks by tag weight × review %", () => {
  const candidates: StoreItem[] = [
    { appid: 100, name: "Owned", tags: [{ tagid: 1, weight: 900 }] },
    {
      appid: 200,
      name: "Great Roguelike",
      tags: [{ tagid: 1, weight: 900 }],
      reviews: { summary_filtered: { percent_positive: 90 } },
    },
    {
      appid: 300,
      name: "Poorly-received Roguelike",
      tags: [{ tagid: 1, weight: 900 }],
      reviews: { summary_filtered: { percent_positive: 20 } },
    },
    { appid: 400, name: "No overlap", tags: [{ tagid: 2, weight: 900 }] },
  ];
  const tagWeights = new Map([["Roguelike", 10]]);
  const s = summarizeRecommendations(
    candidates,
    tagWeights,
    new Set([100]), // owned
    RECO_TAG_MAP,
    10,
    ["Roguelike"],
  ) as {
    found: boolean;
    based_on_tags: string[];
    count: number;
    recommendations: { appid: number }[];
  };
  assert.equal(s.found, true);
  assert.deepEqual(s.based_on_tags, ["Roguelike"]);
  // Owned (100) and the tag-less-overlap item (400) never appear.
  assert.deepEqual(
    s.recommendations.map((r) => r.appid),
    [200, 300],
  );
  // 90%-reviewed beats 20%-reviewed despite an identical tag match.
  assert.equal(s.recommendations[0]!.appid, 200);
});

test("summarizeRecommendations: exclude_tags drops a match even via its FULL tag set, not just the display cap", () => {
  const candidates: StoreItem[] = [
    {
      appid: 500,
      name: "Secretly a Souls-like",
      // Souls-like (3) is present but far from the top-weighted tag, so it
      // would fall outside resolveTags' display cap — exclusion must still see it.
      tags: [
        { tagid: 1, weight: 900 },
        { tagid: 3, weight: 1 },
      ],
    },
    { appid: 600, name: "Not a Souls-like", tags: [{ tagid: 1, weight: 900 }] },
  ];
  const tagWeights = new Map([["Roguelike", 10]]);
  const s = summarizeRecommendations(
    candidates,
    tagWeights,
    new Set(),
    RECO_TAG_MAP,
    10,
    ["Roguelike"],
    ["souls-like"], // case-insensitive
  ) as { recommendations: { appid: number }[] };
  assert.deepEqual(
    s.recommendations.map((r) => r.appid),
    [600],
  );
});
