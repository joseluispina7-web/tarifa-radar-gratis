const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildGoogleHotelsSearchUrl,
  buildGoogleOffer,
  parseGoogleGuestRating,
  parseGoogleHotelsNightly,
  parseGoogleHotelsNights,
  parseGoogleHotelsTotal,
  parseGoogleStars,
  stableOfferId,
} = require("../src/google-hotels-scraper.cjs");
const { normalizeSearch } = require("../src/booking-scraper.cjs");

function search(overrides = {}) {
  return normalizeSearch({
    destination: "Madrid, Comunidad de Madrid, Espana",
    searchArea: "Madrid",
    checkIn: "2026-08-05",
    checkOut: "2026-08-09",
    adults: 2,
    children: 0,
    rooms: 1,
    maxTotal: 150,
    maxNightly: 40,
    ...overrides,
  });
}

test("builds a Google Hotels search without pretending URL dates work", () => {
  const url = new URL(buildGoogleHotelsSearchUrl(search()));
  assert.equal(url.origin, "https://www.google.com");
  assert.equal(url.pathname, "/travel/search");
  assert.match(url.searchParams.get("q"), /hoteles en Madrid/);
  assert.equal(url.searchParams.get("curr"), "EUR");
  assert.equal(url.searchParams.has("checkin"), false);
  assert.equal(url.searchParams.has("checkout"), false);
});

test("parses the explicit taxed stay total and nightly amount", () => {
  const text =
    "33 \u20ac130 \u20ac en total4 noches con impuestos y tasas incluidos33 \u20ac5-9 ago";
  assert.equal(parseGoogleHotelsNightly(text), 33);
  assert.equal(parseGoogleHotelsTotal(text), 130);
  assert.equal(parseGoogleHotelsNights(text), 4);
  const english =
    "33 \u20ac130 \u20ac total4 nights including taxes and fees33 \u20acAug 5-9";
  assert.equal(parseGoogleHotelsNightly(english), 33);
  assert.equal(parseGoogleHotelsTotal(english), 130);
  assert.equal(parseGoogleHotelsNights(english), 4);
  const prefixEnglish =
    "\u20ac33\u20ac130 total4 nights including taxes and fees\u20ac33Aug 5-9";
  assert.equal(parseGoogleHotelsNightly(prefixEnglish), 33);
  assert.equal(parseGoogleHotelsTotal(prefixEnglish), 130);
});

test("normalizes Google review rating to the ten-point panel scale", () => {
  assert.equal(
    parseGoogleGuestRating("4,8 de 5 estrellas de 3.568 resenas"),
    9.6,
  );
  assert.equal(parseGoogleStars("Hotel de 4 estrellas"), 4);
  assert.equal(parseGoogleGuestRating("4.8 out of 5 stars"), 9.6);
  assert.equal(parseGoogleStars("4-star hotel"), 4);
});

test("accepts an explicit English total from GitHub runners", () => {
  const offer = buildGoogleOffer(
    {
      hotelName: "Hotel Center",
      priceText:
        "37 \u20ac148 \u20ac total4 nights including taxes and fees37 \u20acAug 5-9",
      text: "4.4 out of 5 stars from 320 reviews 3-star hotel Pool",
      labels: ["Amenities: Pool, Air conditioning"],
      url: "https://www.google.com/travel/search?qs=hotel",
    },
    search(),
  );
  assert.equal(offer.totalPrice, 148);
  assert.equal(offer.stars, 3);
  assert.equal(offer.guestRating, 8.8);
  assert.deepEqual(
    offer.amenities.sort(),
    ["air_conditioning", "pool"],
  );
});

test("builds a verified source-specific offer only from an explicit total", () => {
  const offer = buildGoogleOffer(
    {
      hotelName: "Hotel Centro",
      priceText:
        "37 \u20ac148 \u20ac en total4 noches con impuestos y tasas incluidos",
      text: "4,4 de 5 estrellas de 320 resenas Hotel de 3 estrellas Piscina",
      labels: ["Servicios: Piscina, Aire acondicionado"],
      url: "https://www.google.com/travel/search?qs=hotel",
    },
    search(),
  );
  assert.equal(offer.source, "google_hotels");
  assert.equal(offer.totalPrice, 148);
  assert.equal(offer.nightlyPrice, 37);
  assert.equal(offer.priceVerified, true);
  assert.equal(offer.priceConfirmationCount, 2);
  assert.equal(offer.stars, 3);
  assert.equal(offer.guestRating, 8.8);
  assert.deepEqual(
    offer.amenities.sort(),
    ["air_conditioning", "pool"],
  );
  assert.equal(offer.matches, true);
});

test("rejects cards without exact nights, taxes or a total", () => {
  const base = {
    hotelName: "Hotel dudoso",
    text: "",
    labels: [],
    url: "https://www.google.com/travel/search?qs=hotel",
  };
  assert.equal(
    buildGoogleOffer(
      {
        ...base,
        priceText: "40 \u20ac por noche",
      },
      search(),
    ),
    null,
  );
  assert.equal(
    buildGoogleOffer(
      {
        ...base,
        priceText: "40 \u20ac160 \u20ac en total3 noches con impuestos incluidos",
      },
      search(),
    ),
    null,
  );
});

test("does not match shared-room Google results by default", () => {
  const offer = buildGoogleOffer(
    {
      hotelName: "Double Room with Shared Bathroom",
      priceText:
        "33 \u20ac130 \u20ac en total4 noches con impuestos y tasas incluidos",
      text: "4,8 de 5 estrellas",
      labels: [],
      url: "https://www.google.com/travel/search?qs=shared",
    },
    search(),
  );
  assert.equal(offer.sharedRoom, true);
  assert.equal(offer.matches, false);
});

test("keeps Google IDs stable and separate from Booking IDs", () => {
  const id = stableOfferId("Hotel Centro", "2026-08-05", "2026-08-09");
  assert.match(id, /^google_hotels:/);
  assert.equal(
    id,
    stableOfferId("Hotel Centro", "2026-08-05", "2026-08-09"),
  );
});
