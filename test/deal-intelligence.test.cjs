const assert = require("node:assert/strict");
const test = require("node:test");
const {
  annotateMarketPrices,
  applyPriceDropIntelligence,
  enrichDealComparisons,
  hotelNamesMatch,
  median,
} = require("../src/deal-intelligence.cjs");

test("scores a verified offer against the current market median", () => {
  const offers = [40, 80, 90, 100, 110, 120].map((nightlyPrice, index) => ({
    id: String(index),
    nightlyPrice,
    priceVerified: index === 0,
    priceConfirmationCount: index === 0 ? 2 : 0,
  }));
  const market = annotateMarketPrices(offers);
  assert.equal(median([80, 90, 100, 110]), 95);
  assert.equal(market.medianNightly, 95);
  assert.equal(offers[0].discountPercent, 57.9);
  assert.ok(offers[0].errorFareScore >= 90);
  assert.equal(offers[0].errorFareLevel, "probable_error");
});

test("does not claim a market anomaly from a tiny sample", () => {
  const offers = [{ nightlyPrice: 20 }, { nightlyPrice: 100 }];
  annotateMarketPrices(offers);
  assert.equal(offers[0].marketSampleSize, 0);
  assert.equal(offers[0].discountPercent, 0);
});

test("adds a bounded signal for a genuine price drop", () => {
  const offer = applyPriceDropIntelligence(
    { totalPrice: 150, errorFareScore: 70 },
    200,
  );
  assert.equal(offer.priceDropPercent, 25);
  assert.equal(offer.errorFareScore, 83);
  assert.equal(offer.errorFareLevel, "probable_error");
});

test("groups the same hotel conservatively across providers", () => {
  assert.equal(
    hotelNamesMatch("Hotel Grand Plaza Madrid", "Grand Plaza Madrid Hotel"),
    true,
  );
  assert.equal(hotelNamesMatch("Hotel Sol", "Apartamentos Sol"), false);

  const deals = enrichDealComparisons([
    {
      id: "booking",
      monitorId: "madrid",
      hotelName: "Hotel Grand Plaza Madrid",
      checkIn: "2026-10-01",
      checkOut: "2026-10-04",
      source: "booking",
      provider: "Booking",
      totalPrice: 240,
      nightlyPrice: 80,
      errorFareScore: 60,
    },
    {
      id: "trip",
      monitorId: "madrid",
      hotelName: "Grand Plaza Madrid Hotel",
      checkIn: "2026-10-01",
      checkOut: "2026-10-04",
      source: "trip",
      provider: "Trip.com",
      totalPrice: 225,
      nightlyPrice: 75,
      errorFareScore: 62,
    },
    {
      id: "other",
      monitorId: "madrid",
      hotelName: "Apartamentos Sol",
      checkIn: "2026-10-01",
      checkOut: "2026-10-04",
      source: "bluepillow",
      totalPrice: 200,
      nightlyPrice: 66.67,
    },
  ]);

  assert.equal(deals[0].comparisonGroupId, deals[1].comparisonGroupId);
  assert.notEqual(deals[0].comparisonGroupId, deals[2].comparisonGroupId);
  assert.equal(deals[0].providerCount, 2);
  assert.equal(deals[1].isBestPrice, true);
  assert.equal(deals[0].errorFareScore, 70);
});
