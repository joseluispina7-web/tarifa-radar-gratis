const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildBluepillowOffer,
  chooseDestination,
  linkMatchesStay,
  stableBluepillowOfferId,
} = require("../src/bluepillow-scraper.cjs");
const { normalizeSearch } = require("../src/booking-scraper.cjs");

function search(overrides = {}) {
  return normalizeSearch({
    destination: "Benidorm, Comunidad Valenciana, Espana",
    searchArea: "Benidorm",
    countryCode: "ES",
    originLatitude: 38.53816,
    originLongitude: -0.13098,
    checkIn: "2026-08-05",
    checkOut: "2026-08-09",
    adults: 2,
    children: 0,
    rooms: 1,
    maxTotal: 500,
    maxDistanceKm: 10,
    ...overrides,
  });
}

function property(overrides = {}) {
  return {
    id: "prop_benidorm",
    name: "B&B Hotel Benidorm Finestrat",
    property_type: "hotel",
    rating: 4.4,
    rating_count: 320,
    stars: 3,
    location: {
      lat: 38.53433,
      lon: -0.173317,
      address: "Avenida Example 1",
      city: "Finestrat",
      country: "ES",
    },
    amenities: ["pool", "air_conditioning"],
    features: [],
    availability_status: "available",
    thumbnail_url: "https://images.example/hotel.jpg",
    price: {
      ota: "Booking",
      amount: 481.95,
      amount_per_night: 120.49,
      currency: "EUR",
      refundable: true,
      breakfast_included: false,
    },
    offers: [
      {
        ota: "Booking",
        amount: 481.95,
        amount_per_night: 120.49,
        currency: "EUR",
        refundable: true,
        breakfast_included: false,
        deeplink_url:
          "https://www.bluepillow.com/skippy?begin=2026-08-05&end=2026-08-09&connectorname=Booking",
      },
      {
        ota: "Agoda",
        amount: 437.06,
        amount_per_night: 109.27,
        currency: "EUR",
        refundable: false,
        breakfast_included: true,
        deeplink_url:
          "https://www.bluepillow.com/skippy?begin=2026-08-05&end=2026-08-09&connectorname=Agoda",
      },
      {
        ota: "TripCom",
        amount: 567,
        amount_per_night: 141.75,
        currency: "EUR",
        refundable: true,
        breakfast_included: false,
        deeplink_url:
          "https://www.bluepillow.com/skippy?begin=2026-08-05&end=2026-08-09&connectorname=TripCom",
      },
    ],
    ...overrides,
  };
}

test("chooses the exact city and country from destination candidates", () => {
  const selected = chooseDestination(
    [
      {
        id: "neighborhood",
        name: "Rincon de Loix",
        display_name: "Rincon de Loix, Benidorm",
        type: "neighborhood",
        country_code: "ES",
        confidence: 0.9,
      },
      {
        id: "city",
        name: "Benidorm",
        display_name: "Benidorm",
        type: "city",
        country_code: "ES",
        confidence: 0.7,
      },
    ],
    search(),
  );
  assert.equal(selected.id, "city");
});

test("recognizes exact dates inside nested affiliate links", () => {
  const nested =
    "https://www.bluepillow.com/skippy?redirecturl=" +
    encodeURIComponent(
      "https://www.agoda.com/search?checkin=2026-08-05&checkout=2026-08-09",
    );
  assert.equal(linkMatchesStay(nested, search()), true);
  assert.equal(
    linkMatchesStay(nested.replace("2026-08-09", "2026-08-10"), search()),
    false,
  );
});

test("builds an independent verified Agoda offer", () => {
  const offer = buildBluepillowOffer(
    property(),
    search(),
    "agoda",
    { price_as_of: "2026-07-29T21:02:09Z" },
  );
  assert.equal(offer.source, "agoda");
  assert.equal(offer.provider, "Agoda via Bluepillow");
  assert.equal(offer.totalPrice, 437.06);
  assert.equal(offer.nightlyPrice, 109.27);
  assert.equal(offer.guestRating, 8.8);
  assert.equal(offer.distanceKm > 0, true);
  assert.equal(offer.breakfastIncluded, true);
  assert.equal(offer.priceConfirmationCount, 2);
  assert.equal(offer.matches, true);
});

test("keeps Trip.com and Bluepillow as separate result sources", () => {
  const trip = buildBluepillowOffer(
    property(),
    search({ maxTotal: 600 }),
    "trip",
  );
  const bluepillow = buildBluepillowOffer(
    property(),
    search(),
    "bluepillow",
  );
  assert.equal(trip.source, "trip");
  assert.equal(trip.provider, "Trip.com via Bluepillow");
  assert.equal(trip.totalPrice, 567);
  assert.equal(trip.matches, true);
  assert.equal(bluepillow.source, "bluepillow");
  assert.equal(bluepillow.provider, "Agoda via Bluepillow");
  assert.equal(bluepillow.totalPrice, 437.06);
  assert.notEqual(trip.id, bluepillow.id);
});

test("rejects stale, inconsistent or non-EUR Bluepillow prices", () => {
  const wrongDates = property({
    offers: property().offers.map((offer) => ({
      ...offer,
      deeplink_url: offer.deeplink_url.replace("2026-08-09", "2026-08-10"),
    })),
  });
  assert.equal(
    buildBluepillowOffer(wrongDates, search(), "agoda"),
    null,
  );
  const inconsistent = property({
    offers: property().offers.map((offer) =>
      offer.ota === "Agoda"
        ? { ...offer, amount_per_night: 30 }
        : offer
    ),
  });
  assert.equal(
    buildBluepillowOffer(inconsistent, search(), "agoda"),
    null,
  );
});

test("keeps Bluepillow source ids stable", () => {
  const id = stableBluepillowOfferId(
    "agoda",
    "prop_benidorm",
    "2026-08-05",
    "2026-08-09",
  );
  assert.equal(
    id,
    stableBluepillowOfferId(
      "agoda",
      "prop_benidorm",
      "2026-08-05",
      "2026-08-09",
    ),
  );
  assert.match(id, /^agoda:/);
});
