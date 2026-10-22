import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeItems,
  summarizeDiscover,
  summarizeWishlistDetailed,
  computeFavoriteTagWeights,
  summarizeRecommendations,
} from "../format/store.ts";
import { summarizeTagList, type StoreItem, type TagMap } from "../format/storeCard.ts";

// Focused unit tests for the store-service card builders and their edge cases —
// discount-end resolution, availability/free handling, empty responses — that the
// server-level integration tests only touch on the happy path.

describe("summarizeItems", () => {
  test("discount_end is the SOONEST valid active-discount end", () => {
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

  test("price.original falls back to the final price when there's no discount", () => {
    // priceFields(): `original: formatted_original_price || formatted_final_price`
    // — Steam omits formatted_original_price entirely when nothing is discounted.
    const r = {
      response: {
        store_items: [
          {
            appid: 1,
            name: "Full price",
            best_purchase_option: { discount_pct: 0, formatted_final_price: "$9.99" },
          },
        ],
      },
    };
    const s = summarizeItems(r, [1]) as {
      items: { price: { original: string; final: string } }[];
    };
    assert.equal(s.items[0]!.price.original, "$9.99");
    assert.equal(s.items[0]!.price.final, "$9.99");
  });

  test("no/zero active discount → discount_end null", () => {
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

  test("missing appid → available:false; free game → price {is_free}", () => {
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

  test("is_free alone (no name/best_purchase_option/reviews) is NOT reported unavailable", () => {
    // Regression: a sparse payload (delisted/beta F2P title) with only is_free
    // set used to fall through to available:false, discarding its free-ness.
    const r = {
      response: {
        store_items: [{ appid: 20, is_free: true }],
      },
    };
    const s = summarizeItems(r, [20]) as {
      items: { appid: number; available?: boolean; is_free?: boolean; price?: unknown }[];
    };
    const item = s.items[0]!;
    assert.notEqual(item.available, false);
    assert.equal(item.is_free, true);
    assert.deepEqual(item.price, { is_free: true });
  });

  test("vr_support is none/supported/required depending on vrhmd/vrhmd_only", () => {
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

test("summarizeDiscover re-checks minDiscount client-side (backstop for Steam's server-side no-op at 100)", () => {
  // Steam's server-side min_discount_percent filter silently returns the full
  // catalog at exactly 100, so summarizeDiscover must re-filter on discount_pct
  // itself — otherwise full-price games leak through as "deals".
  const items: StoreItem[] = [
    { appid: 1, name: "Full price", best_purchase_option: { discount_pct: 0 } },
    { appid: 2, name: "Real deal", best_purchase_option: { discount_pct: 80 } },
  ];
  const s = summarizeDiscover({ response: { store_items: items } }, { minDiscount: 50 }) as {
    deals: { appid: number }[];
  };
  assert.deepEqual(
    s.deals.map((d) => d.appid),
    [2],
  );
});

describe("summarizeWishlistDetailed", () => {
  const mk = (appid: number, priority = 1, discount_pct = 0) => ({
    appid,
    priority,
    store_item: { appid, name: `Game ${appid}`, best_purchase_option: { discount_pct } },
  });

  test("empty wishlist → found:false with a private/empty reason", () => {
    const s = summarizeWishlistDetailed({}, undefined, {}, { total: 0, exact: true }) as {
      found: boolean;
      reason: string;
      total: number;
    };
    assert.equal(s.found, false);
    assert.equal(s.total, 0);
    assert.match(s.reason, /private/i);
  });

  test("nothing matching a non-empty wishlist is found:true with matched 0, not 'private'", () => {
    // A server-filtered response lists only matches, so an empty one plus a
    // non-zero total from the plain list means "nothing matched".
    const s = summarizeWishlistDetailed(
      { response: { items: [] } },
      undefined,
      {},
      { total: 40, exact: true },
    ) as { found: boolean; total: number; matched: number };
    assert.equal(s.found, true);
    assert.equal(s.total, 40);
    assert.equal(s.matched, 0);
  });

  test("keeps wishlist priority order when no discount filter", () => {
    const s = summarizeWishlistDetailed(
      { response: { items: [mk(2, 5), mk(1, 1)] } },
      undefined,
      {},
      { total: 2, exact: true },
    ) as { matched: number; items: { appid: number }[] };
    assert.equal(s.matched, 2);
    assert.equal(s.items[0]!.appid, 1); // priority 1 sorts before priority 5
  });

  test("exact (all filters server-side): every listed entry counts as matched, carded or not", () => {
    // Only the displayed page needs cards then; the rest are listed bare.
    const s = summarizeWishlistDetailed(
      { response: { items: [mk(1), { appid: 2, priority: 2 }, { appid: 3, priority: 3 }] } },
      undefined,
      {},
      { total: 10, exact: true },
    ) as { total: number; matched: number; returned: number; note: string | undefined };
    assert.equal(s.total, 10);
    assert.equal(s.matched, 3);
    assert.equal(s.returned, 1);
    assert.equal(s.note, undefined);
  });

  test("checks run here: uncarded matches are reported via note, not silently dropped", () => {
    const s = summarizeWishlistDetailed(
      { response: { items: [mk(1, 1, 60), { appid: 2, priority: 2 }] } },
      undefined,
      { minDiscount: 50 },
      { total: 5, exact: false },
    ) as { matched: number; enriched: number; note: string | undefined };
    assert.equal(s.matched, 1);
    assert.equal(s.enriched, 1);
    assert.match(s.note!, /2 wishlist items passed/);
  });

  test("checks run here: the own-package discount is re-checked", () => {
    const s = summarizeWishlistDetailed(
      { response: { items: [mk(1, 1, 60), mk(2, 2, 10)] } },
      undefined,
      { minDiscount: 50 },
      { total: 2, exact: false },
    ) as { matched: number; items: { appid: number }[] };
    assert.equal(s.matched, 1);
    assert.equal(s.items[0]!.appid, 1);
  });
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

describe("summarizeRecommendations", () => {
  test("excludes owned/zero-overlap candidates, ranks by tag weight × review %", () => {
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

  test("min_discount re-checks discount client-side (backstop for Steam's server-side no-op at 100)", () => {
    // Same class as the discover_games fix: Steam's server-side price filter
    // no-ops at 100, so a full-price candidate must be dropped here too.
    const candidates: StoreItem[] = [
      {
        appid: 910,
        name: "Full price roguelike",
        tags: [{ tagid: 1, weight: 900 }],
        best_purchase_option: { discount_pct: 0 },
      },
      {
        appid: 920,
        name: "Discounted roguelike",
        tags: [{ tagid: 1, weight: 900 }],
        best_purchase_option: { discount_pct: 60 },
      },
    ];
    const tagWeights = new Map([["Roguelike", 10]]);
    const s = summarizeRecommendations(
      candidates,
      tagWeights,
      new Set(),
      RECO_TAG_MAP,
      10,
      ["Roguelike"],
      50, // minDiscount
    ) as { recommendations: { appid: number }[] };
    assert.deepEqual(
      s.recommendations.map((r) => r.appid),
      [920],
    );
  });
});
