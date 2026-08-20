const assert = require("node:assert/strict");
const test = require("node:test");
const {
  addHotelExclusion,
  exclusionActionId,
  hotelIsExcluded,
} = require("../src/hotel-exclusions.cjs");

test("excludes matching hotel names only inside the selected search", () => {
  const result = addHotelExclusion(
    { version: 1, hotels: [] },
    {
      monitorId: "madrid",
      monitorName: "Madrid centro",
      hotelName: "Hotel Grand Plaza Madrid",
      source: "booking",
    },
    new Date("2026-08-20T21:00:00.000Z"),
  );

  assert.equal(result.added, true);
  assert.equal(
    hotelIsExcluded(result.document, "madrid", "Grand Plaza Madrid Hotel"),
    true,
  );
  assert.equal(
    hotelIsExcluded(result.document, "barcelona", "Grand Plaza Madrid Hotel"),
    false,
  );
});

test("does not duplicate an already excluded hotel from another provider", () => {
  const first = addHotelExclusion(
    { hotels: [] },
    { monitorId: "madrid", hotelName: "Hotel Grand Plaza Madrid" },
  );
  const second = addHotelExclusion(
    first.document,
    { monitorId: "madrid", hotelName: "Grand Plaza Madrid Hotel" },
  );

  assert.equal(second.added, false);
  assert.equal(second.document.hotels.length, 1);
  assert.equal(
    exclusionActionId({ monitorId: "madrid", hotelName: "Hotel Centro" }),
    exclusionActionId({ monitorId: "madrid", hotelName: "Hotel Centro" }),
  );
});
