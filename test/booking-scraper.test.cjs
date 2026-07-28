const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildBookingSearchUrl,
  isSharedRoomText,
  matchesSearch,
  nightsBetween,
  normalizeSearch,
  parseEuroPrice,
  parseReviewCount,
  parseReviewScore,
  parseStars,
} = require("../src/booking-scraper.cjs");
const { compareWithState } = require("../src/state.cjs");

const searchInput = {
  destination: { query: "Madrid", label: "Madrid, España" },
  checkIn: "2026-08-23",
  checkOut: "2026-08-27",
  adults: 2,
  rooms: 1,
  maxTotal: 150,
  maxNightly: 30,
  priceRule: "or",
};

test("builds an exact Booking search without affiliate credentials", () => {
  const url = new URL(buildBookingSearchUrl(searchInput));
  assert.equal(url.origin, "https://www.booking.com");
  assert.equal(url.searchParams.get("ss"), "Madrid");
  assert.equal(url.searchParams.get("checkin"), "2026-08-23");
  assert.equal(url.searchParams.get("checkout"), "2026-08-27");
  assert.equal(url.searchParams.get("selected_currency"), "EUR");
  assert.equal(url.searchParams.has("aid"), false);
});

test("calculates nights from exact dates", () => {
  assert.equal(nightsBetween("2026-08-23", "2026-08-27"), 4);
  assert.equal(normalizeSearch(searchInput).nights, 4);
});

test("parses Booking prices and Spanish review values", () => {
  assert.equal(parseEuroPrice("€ 319 € 153"), 153);
  assert.equal(parseEuroPrice("€ 1.245,50"), 1245.5);
  assert.equal(parseReviewScore("Puntuación: 8,0 8,0 Muy bien"), 8);
  assert.equal(parseReviewCount("Muy bien 2.074 comentarios"), 2074);
  assert.equal(parseStars("3 de 5"), 3);
});

test("applies total or nightly budget without requiring stars", () => {
  const search = normalizeSearch(searchInput);
  assert.equal(
    matchesSearch(
      {
        totalPrice: 153,
        nightlyPrice: 38.25,
        stars: 0,
        guestRating: 8,
        freeCancellation: false,
      },
      search,
    ),
    false,
  );
  assert.equal(
    matchesSearch(
      {
        totalPrice: 149,
        nightlyPrice: 37.25,
        stars: 0,
        guestRating: 6.5,
        freeCancellation: false,
        sharedRoom: false,
      },
      search,
    ),
    true,
  );
});

test("excludes shared beds by default but can include them explicitly", () => {
  assert.equal(
    isSharedRoomText("Cama individual en habitación compartida femenina"),
    true,
  );
  const offer = {
    totalPrice: 100,
    nightlyPrice: 25,
    stars: 0,
    guestRating: 7,
    freeCancellation: false,
    sharedRoom: true,
  };
  assert.equal(matchesSearch(offer, normalizeSearch(searchInput)), false);
  assert.equal(
    matchesSearch(
      offer,
      normalizeSearch({ ...searchInput, excludeSharedRooms: false }),
    ),
    true,
  );
});

test("reports only new matches and genuine price drops", () => {
  const result = {
    searchedAt: "2026-07-29T01:00:00.000Z",
    search: { id: "madrid" },
    offers: [
      {
        id: "hotel-a",
        hotelName: "Hotel A",
        totalPrice: 120,
        nightlyPrice: 30,
        matches: true,
      },
      {
        id: "hotel-b",
        hotelName: "Hotel B",
        totalPrice: 180,
        nightlyPrice: 45,
        matches: false,
      },
    ],
  };
  const first = compareWithState({}, result);
  assert.equal(first.changes.length, 1);
  assert.equal(first.changes[0].type, "new_match");

  const unchanged = compareWithState(first.state, {
    ...result,
    searchedAt: "2026-07-29T01:05:00.000Z",
  });
  assert.equal(unchanged.changes.length, 0);

  const cheaper = compareWithState(unchanged.state, {
    ...result,
    searchedAt: "2026-07-29T01:10:00.000Z",
    offers: [{ ...result.offers[0], totalPrice: 100, nightlyPrice: 25 }],
  });
  assert.equal(cheaper.changes.length, 1);
  assert.equal(cheaper.changes[0].type, "price_drop");
  assert.equal(cheaper.changes[0].previousPrice, 120);
});
