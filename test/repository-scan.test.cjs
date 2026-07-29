const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDealMap,
  clearSearchedDeals,
  monitorFingerprint,
  offerStateIsConfirmed,
  updateOfferState,
} = require("../src/repository-scan.cjs");

const monitor = {
  id: "search-1",
  location: "Benidorm, España",
  dateMode: "fixed",
  dateStart: "2026-08-05",
  dateEnd: "2026-08-09",
  minNights: 4,
  maxNights: 4,
  adults: 2,
  children: 0,
  rooms: 1,
  sources: ["booking"],
};

test("drops deals created for an older monitor configuration", () => {
  const currentFingerprint = monitorFingerprint(monitor);
  const deals = buildDealMap(
    {
      deals: [
        {
          id: "old-madrid",
          monitorId: monitor.id,
          monitorFingerprint: "old-config",
        },
        {
          id: "current-benidorm",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
        },
      ],
    },
    [monitor],
  );
  assert.deepEqual(Array.from(deals.keys()), ["current-benidorm"]);
});

test("replaces only deals for the date pair just searched", () => {
  const deals = new Map([
    [
      "searched",
      {
        monitorId: monitor.id,
        checkIn: "2026-08-05",
        checkOut: "2026-08-09",
      },
    ],
    [
      "other-dates",
      {
        monitorId: monitor.id,
        checkIn: "2026-08-12",
        checkOut: "2026-08-16",
      },
    ],
  ]);
  clearSearchedDeals(deals, monitor.id, {
    checkIn: "2026-08-05",
    checkOut: "2026-08-09",
  });
  assert.deepEqual(Array.from(deals.keys()), ["other-dates"]);
});

test("publishes a price only after two different scan cycles", () => {
  const offer = {
    hotelName: "Hotel estable",
    totalPrice: 120,
    nightlyPrice: 30,
    matches: true,
    priceVerified: true,
    priceBasis: "booking_availability_table",
    searchArea: "Benidorm",
    checkIn: "2026-08-05",
    checkOut: "2026-08-09",
  };
  const first = updateOfferState(
    {},
    offer,
    "2026-07-29T08:45:00.000Z",
    "cycle-1",
  );
  assert.equal(first.confirmationCount, 1);
  assert.equal(offerStateIsConfirmed(first), false);

  const migrated = updateOfferState(
    { matches: true, totalPrice: 120 },
    offer,
    "2026-07-29T08:45:00.000Z",
    "cycle-1",
  );
  assert.equal(migrated.confirmationCount, 1);
  assert.equal(offerStateIsConfirmed(migrated), false);

  const duplicateInCycle = updateOfferState(
    first,
    offer,
    "2026-07-29T08:45:20.000Z",
    "cycle-1",
  );
  assert.equal(duplicateInCycle.confirmationCount, 1);

  const second = updateOfferState(
    duplicateInCycle,
    offer,
    "2026-07-29T08:50:00.000Z",
    "cycle-2",
  );
  assert.equal(second.confirmationCount, 2);
  assert.equal(offerStateIsConfirmed(second), true);

  const changedPrice = updateOfferState(
    second,
    { ...offer, totalPrice: 130, nightlyPrice: 32.5 },
    "2026-07-29T08:55:00.000Z",
    "cycle-3",
  );
  assert.equal(changedPrice.confirmationCount, 1);
  assert.equal(offerStateIsConfirmed(changedPrice), false);

  const unavailable = updateOfferState(
    second,
    { ...offer, matches: false, priceVerified: false },
    "2026-07-29T08:55:00.000Z",
    "cycle-3",
  );
  assert.equal(unavailable.confirmationCount, 0);
  assert.equal(unavailable.publishedPrice, 0);
});
