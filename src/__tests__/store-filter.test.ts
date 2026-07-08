import { test } from "node:test";
import assert from "node:assert/strict";
import { storeItemFilter, type StoreItem } from "../format/store.js";

// Focused unit tests for the shared predicate behind discover_games and the
// wishlist detailed view. Each test isolates one filter dimension on minimal
// StoreItems; combinations are AND (every active filter must pass).

const item = (o: Partial<StoreItem> = {}): StoreItem => ({ appid: 1, ...o });
const withDeck = (c: number) => item({ platforms: { steam_deck_compat_category: c } });

test("no filters pass everything (even a bare item)", () => {
  const keep = storeItemFilter({});
  assert.ok(keep(item()));
});

test("compat filter: 'verified' keeps only category 3", () => {
  const keep = storeItemFilter({ steamDeck: "verified" });
  assert.ok(keep(withDeck(3)));
  assert.ok(!keep(withDeck(2)));
  assert.ok(!keep(withDeck(1)));
  assert.ok(!keep(item({ platforms: {} }))); // unknown (0)
});

test("compat filter: 'playable' keeps Playable or Verified (2 and 3)", () => {
  const keep = storeItemFilter({ steamDeck: "playable" });
  assert.ok(keep(withDeck(3)));
  assert.ok(keep(withDeck(2)));
  assert.ok(!keep(withDeck(1)));
});

test("each compat filter reads its OWN category field", () => {
  assert.ok(
    storeItemFilter({ steamOs: "playable" })(item({ platforms: { steam_os_compat_category: 2 } })),
  );
  assert.ok(
    !storeItemFilter({ steamOs: "verified" })(item({ platforms: { steam_os_compat_category: 2 } })),
  );
  assert.ok(
    storeItemFilter({ steamFrame: "verified" })(
      item({ platforms: { steam_frame_compat_category: 3 } }),
    ),
  );
  // A Deck filter must NOT be satisfied by a SteamOS rating.
  assert.ok(
    !storeItemFilter({ steamDeck: "verified" })(
      item({ platforms: { steam_os_compat_category: 3 } }),
    ),
  );
});

test("native-platform filter maps linux→steamos_linux and matches the right flag", () => {
  const linux = storeItemFilter({ platform: "linux" });
  assert.ok(linux(item({ platforms: { steamos_linux: true } })));
  assert.ok(!linux(item({ platforms: { windows: true, mac: true } })));
  const mac = storeItemFilter({ platform: "mac" });
  assert.ok(mac(item({ platforms: { mac: true } })));
  assert.ok(!mac(item({ platforms: { windows: true, steamos_linux: true } })));
});

test("tag filter matches the FULL tag set (incl. low-weighted), case-insensitive, AND", () => {
  const tagMap = {
    1: "Action",
    2: "Adventure",
    3: "Indie",
    4: "Singleplayer",
    5: "Story Rich",
    6: "Great Soundtrack",
    7: "Difficult",
    8: "Atmospheric",
    9: "Metroidvania",
  };
  // Metroidvania (tagid 9) has the lowest weight — past any display cap.
  const it = item({
    tags: [1, 2, 3, 4, 5, 6, 7, 8]
      .map((tagid, i) => ({ tagid, weight: 900 - i * 10 }))
      .concat([{ tagid: 9, weight: 5 }]),
  });
  assert.ok(storeItemFilter({ tags: ["Metroidvania"], tagMap })(it)); // matched despite low weight
  assert.ok(storeItemFilter({ tags: ["metroidvania"], tagMap })(it)); // case-insensitive
  assert.ok(storeItemFilter({ tags: ["Action", "Metroidvania"], tagMap })(it)); // AND, both present
  assert.ok(!storeItemFilter({ tags: ["Horror"], tagMap })(it)); // absent tag
  assert.ok(!storeItemFilter({ tags: ["Action", "Horror"], tagMap })(it)); // AND, one absent
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

test("releasedAfter keeps on/after the cutoff, drops older and undated", () => {
  const cutoff = 1_600_000_000;
  const keep = storeItemFilter({ releasedAfter: cutoff });
  assert.ok(keep(item({ release: { steam_release_date: cutoff } })));
  assert.ok(keep(item({ release: { steam_release_date: cutoff + 1 } })));
  assert.ok(!keep(item({ release: { steam_release_date: cutoff - 1 } })));
  assert.ok(!keep(item())); // no release date
});

test("multiple filters combine with AND — flipping any one dimension excludes the item", () => {
  const keep = storeItemFilter({
    minDiscount: 50,
    minReview: 80,
    platform: "linux",
    tags: ["Roguelike"],
    tagMap: { 1: "Roguelike" },
  });
  const good = item({
    best_purchase_option: { discount_pct: 75 },
    reviews: { summary_filtered: { percent_positive: 90 } },
    platforms: { steamos_linux: true },
    tags: [{ tagid: 1, weight: 500 }],
  });
  assert.ok(keep(good));
  assert.ok(!keep({ ...good, best_purchase_option: { discount_pct: 40 } })); // discount fails
  assert.ok(!keep({ ...good, reviews: { summary_filtered: { percent_positive: 70 } } })); // review fails
  assert.ok(!keep({ ...good, platforms: { windows: true } })); // native platform fails
  assert.ok(!keep({ ...good, tags: [{ tagid: 99, weight: 500 }] })); // tag fails
});
