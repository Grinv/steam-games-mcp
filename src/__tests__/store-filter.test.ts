import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { storeItemFilter, type StoreItem } from "../format/storeCard.js";

// Focused unit tests for the shared predicate behind discover_games and the
// wishlist detailed view. Each test isolates one filter dimension on minimal
// StoreItems; combinations are AND (every active filter must pass).

const item = (o: Partial<StoreItem> = {}): StoreItem => ({ appid: 1, ...o });
const withDeck = (c: number) => item({ platforms: { steam_deck_compat_category: c } });

test("no filters pass everything (even a bare item)", () => {
  const keep = storeItemFilter({});
  assert.ok(keep(item()));
});

describe("compat filters", () => {
  test("'verified' keeps only category 3", () => {
    const keep = storeItemFilter({ steamDeck: "verified" });
    assert.ok(keep(withDeck(3)));
    assert.ok(!keep(withDeck(2)));
    assert.ok(!keep(withDeck(1)));
    assert.ok(!keep(item({ platforms: {} }))); // unknown (0)
  });

  test("'playable' keeps Playable or Verified (2 and 3)", () => {
    const keep = storeItemFilter({ steamDeck: "playable" });
    assert.ok(keep(withDeck(3)));
    assert.ok(keep(withDeck(2)));
    assert.ok(!keep(withDeck(1)));
  });

  test("each compat filter reads its OWN category field", () => {
    assert.ok(
      storeItemFilter({ steamOs: "playable" })(
        item({ platforms: { steam_os_compat_category: 2 } }),
      ),
    );
    assert.ok(
      !storeItemFilter({ steamOs: "verified" })(
        item({ platforms: { steam_os_compat_category: 2 } }),
      ),
    );
    assert.ok(
      storeItemFilter({ steamFrame: "verified" })(
        item({ platforms: { steam_frame_compat_category: 3 } }),
      ),
    );
    assert.ok(
      storeItemFilter({ steamMachine: "playable" })(
        item({ platforms: { steam_machine_compat_category: 2 } }),
      ),
    );
    assert.ok(
      !storeItemFilter({ steamMachine: "verified" })(
        item({ platforms: { steam_machine_compat_category: 2 } }),
      ),
    );
    // A Deck filter must NOT be satisfied by a SteamOS rating.
    assert.ok(
      !storeItemFilter({ steamDeck: "verified" })(
        item({ platforms: { steam_os_compat_category: 3 } }),
      ),
    );
    // A SteamOS filter must NOT be satisfied by a Steam Machine rating (they're distinct).
    assert.ok(
      !storeItemFilter({ steamOs: "verified" })(
        item({ platforms: { steam_machine_compat_category: 3 } }),
      ),
    );
  });
});

test("native-platform filter maps linux→steamos_linux and matches the right flag", () => {
  const linux = storeItemFilter({ platform: "linux" });
  assert.ok(linux(item({ platforms: { steamos_linux: true } })));
  assert.ok(!linux(item({ platforms: { windows: true, mac: true } })));
  const mac = storeItemFilter({ platform: "mac" });
  assert.ok(mac(item({ platforms: { mac: true } })));
  assert.ok(!mac(item({ platforms: { windows: true, steamos_linux: true } })));
});

test("minReview / minReviews compare on the raw summary (missing = excluded)", () => {
  const rev = (percent_positive?: number, review_count?: number) =>
    item({ reviews: { summary_filtered: { percent_positive, review_count } } });
  const byPct = storeItemFilter({ minReview: 80 });
  assert.ok(byPct(rev(80)));
  assert.ok(!byPct(rev(79)));
  assert.ok(!byPct(item())); // no reviews → treated as below any threshold
  const byCount = storeItemFilter({ minReviews: 100 });
  assert.ok(byCount(rev(undefined, 100)));
  assert.ok(!byCount(rev(undefined, 99)));
  assert.ok(!byCount(item()));
});

test("minReview: 0 is a no-op — it must NOT drop games with no review summary", () => {
  // A 0 threshold means "no minimum". The missing-data (-1) sentinel would
  // fail `-1 < 0`, so a brand-new game with no reviews must still pass.
  const keep = storeItemFilter({ minReview: 0 });
  assert.ok(keep(item())); // no reviews at all → still kept
  assert.ok(keep(item({ reviews: { summary_filtered: { percent_positive: 0 } } }))); // all-negative → kept
});

test("minDiscount / onSaleOnly filter on discount, and minDiscount overrides onSaleOnly", () => {
  const disc = (discount_pct: number) => item({ best_purchase_option: { discount_pct } });
  const min = storeItemFilter({ minDiscount: 50 });
  assert.ok(min(disc(50)));
  assert.ok(!min(disc(49)));
  const sale = storeItemFilter({ onSaleOnly: true });
  assert.ok(sale(disc(10)));
  assert.ok(!sale(disc(0)));
  assert.ok(!sale(item())); // no purchase option → 0% off
  // When both are set, minDiscount wins: a 10%-off item on sale still fails min 50.
  const both = storeItemFilter({ minDiscount: 50, onSaleOnly: true });
  assert.ok(both(disc(60)));
  assert.ok(!both(disc(10)));
});

test("multiple filters combine with AND — flipping any one dimension excludes the item", () => {
  const keep = storeItemFilter({
    minDiscount: 50,
    minReview: 80,
    platform: "linux",
  });
  const good = item({
    best_purchase_option: { discount_pct: 75 },
    reviews: { summary_filtered: { percent_positive: 90 } },
    platforms: { steamos_linux: true },
  });
  assert.ok(keep(good));
  assert.ok(!keep({ ...good, best_purchase_option: { discount_pct: 40 } })); // discount fails
  assert.ok(!keep({ ...good, reviews: { summary_filtered: { percent_positive: 70 } } })); // review fails
  assert.ok(!keep({ ...good, platforms: { windows: true } })); // native platform fails
});

test("a compat + minReviews combo still ANDs correctly", () => {
  // The other combo test above never includes a compat filter or minReviews
  // alongside the rest. (Tags and the release date run server-side now.)
  const keep = storeItemFilter({
    steamDeck: "verified",
    minReviews: 100,
  });
  const good = item({
    platforms: { steam_deck_compat_category: 3 },
    reviews: { summary_filtered: { review_count: 150 } },
  });
  assert.ok(keep(good));
  assert.ok(!keep({ ...good, platforms: { steam_deck_compat_category: 2 } })); // compat fails
  assert.ok(
    !keep({ ...good, reviews: { summary_filtered: { review_count: 50 } } }), // minReviews fails
  );
});
