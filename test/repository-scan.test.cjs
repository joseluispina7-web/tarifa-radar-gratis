const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDealMap,
  clearSearchedDeals,
  monitorFingerprint,
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
