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

test("drops old Bluepillow deals that were never revalidated", () => {
  const currentFingerprint = monitorFingerprint(monitor);
  const deals = buildDealMap(
    {
      deals: [
        {
          id: "old-bluepillow",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "bluepillow",
        },
        {
          id: "validated-bluepillow",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "bluepillow",
          priceConfirmedAt: "2026-07-30T08:00:00.000Z",
        },
      ],
    },
    [monitor],
  );
  assert.deepEqual(Array.from(deals.keys()), ["validated-bluepillow"]);
});

test("clears one source without deleting the other source", () => {
  const deals = new Map([
    [
      "booking",
      {
        monitorId: monitor.id,
        source: "booking",
        checkIn: "2026-08-05",
        checkOut: "2026-08-09",
      },
    ],
    [
      "google",
      {
        monitorId: monitor.id,
        source: "google_hotels",
        checkIn: "2026-08-05",
        checkOut: "2026-08-09",
      },
    ],
  ]);
  clearSearchedDeals(
    deals,
    monitor.id,
    {
      checkIn: "2026-08-05",
      checkOut: "2026-08-09",
    },
    null,
    "google_hotels",
  );
  assert.deepEqual(Array.from(deals.keys()), ["booking"]);
});

test("replaces deals covered by one flexible Booking window", () => {
  const deals = new Map([
    [
      "inside-one-night",
      {
        monitorId: monitor.id,
        checkIn: "2026-08-08",
        checkOut: "2026-08-09",
        nights: 1,
      },
    ],
    [
      "inside-two-nights",
      {
        monitorId: monitor.id,
        checkIn: "2026-08-08",
        checkOut: "2026-08-10",
        nights: 2,
      },
    ],
    [
      "outside",
      {
        monitorId: monitor.id,
        checkIn: "2026-08-20",
        checkOut: "2026-08-21",
        nights: 1,
      },
    ],
  ]);
  clearSearchedDeals(deals, monitor.id, {
    checkIn: "2026-08-06",
    checkOut: "2026-08-07",
    nights: 1,
    flexibleCheckInStart: "2026-07-30",
    flexibleCheckInEnd: "2026-08-13",
  });
  assert.deepEqual(Array.from(deals.keys()), [
    "inside-two-nights",
    "outside",
  ]);
});

test("publishes a price after two checks in the same scan cycle", () => {
  const offer = {
    source: "google_hotels",
    hotelName: "Hotel estable",
    totalPrice: 120,
    nightlyPrice: 30,
    matches: true,
    priceVerified: true,
    priceConfirmationCount: 2,
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
  assert.equal(first.confirmationCount, 2);
  assert.equal(first.source, "google_hotels");
  assert.equal(offerStateIsConfirmed(first), true);

  const unconfirmed = updateOfferState(
    first,
    { ...offer, priceConfirmationCount: 1 },
    "2026-07-29T08:45:00.000Z",
    "cycle-1",
  );
  assert.equal(unconfirmed.confirmationCount, 1);
  assert.equal(offerStateIsConfirmed(unconfirmed), false);

  const changedPrice = updateOfferState(
    first,
    {
      ...offer,
      totalPrice: 130,
      nightlyPrice: 32.5,
      priceConfirmationCount: 0,
    },
    "2026-07-29T08:55:00.000Z",
    "cycle-3",
  );
  assert.equal(changedPrice.confirmationCount, 0);
  assert.equal(offerStateIsConfirmed(changedPrice), false);

  const unavailable = updateOfferState(
    first,
    { ...offer, matches: false, priceVerified: false },
    "2026-07-29T08:55:00.000Z",
    "cycle-3",
  );
  assert.equal(unavailable.confirmationCount, 0);
  assert.equal(unavailable.publishedPrice, 0);
});
