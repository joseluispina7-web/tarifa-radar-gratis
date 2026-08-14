const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildBluepillowOffer,
  chooseDestination,
  linkMatchesStay,
  parseBluepillowPriceBreakdown,
  parseTripFinalTotal,
  providerRedirectUrl,
  resolveBluepillowDestination,
  scrapeBluepillowSource,
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
          "https://www.bluepillow.com/skippy?begin=2026-08-05&end=2026-08-09&connectorname=Agoda&TotalPrice=437.06&TotalTax=39.73&TotalFee=0",
      },
      {
        ota: "TripCom",
        amount: 567,
        amount_per_night: 141.75,
        currency: "EUR",
        refundable: true,
        breakfast_included: false,
        deeplink_url:
          "https://www.bluepillow.com/skippy?begin=2026-08-05&end=2026-08-09&connectorname=TripCom&display=inctotal",
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

test("falls back from a neighbourhood to its parent city", async () => {
  const requestedNames = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requestedNames.push(body.name);
    if (body.name === "Malasaña") {
      return Response.json(
        { error: { message: "not found" } },
        { status: 404 },
      );
    }
    return Response.json({
      candidates: [{
        id: "dest_madrid",
        name: "Madrid",
        display_name: "Madrid, España",
        type: "city",
        country_code: "ES",
        confidence: 1,
      }],
    });
  };
  const destination = await resolveBluepillowDestination(
    search({
      destination: "Malasaña, Madrid, España",
      locationCity: "Madrid",
      locationRadiusKm: 3,
    }),
    { fetchImpl },
  );

  assert.deepEqual(requestedNames, ["Malasaña", "Madrid"]);
  assert.equal(destination.id, "dest_madrid");
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
  assert.equal(offer.includedTaxesAndFees, 39.73);
  assert.equal(offer.priceVerified, false);
  assert.equal(offer.priceConfirmationCount, 0);
  assert.equal(offer.matches, true);
});

test("reads the final total from the Trip.com price detail", () => {
  const html = String.raw`\"priceDetail\":{\"leaveReturn\":{},\"priceInfo\":{\"totalPrice\":{\"title\":\"Total\",\"content\":\"€333.79\",\"contentDesc\":\"\"}}}`;
  assert.equal(parseTripFinalTotal(html), 333.79);
  assert.equal(parseTripFinalTotal("Total aproximado €99"), 0);

  const target =
    "https://us.trip.com/hotels/list/searchresults?checkin=2026-08-05&checkout=2026-08-09";
  assert.equal(
    providerRedirectUrl(
      `https://www.bluepillow.com/skippy?redirecturl=${encodeURIComponent(target)}`,
    ),
    target,
  );
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

test("requires evidence that taxes are included in Bluepillow totals", () => {
  const agoda = property().offers.find((offer) => offer.ota === "Agoda");
  assert.deepEqual(parseBluepillowPriceBreakdown(agoda), {
    totalPrice: 437.06,
    includedTaxes: 39.73,
    includedFees: 0,
    evidence: "agoda_total_with_tax_breakdown",
  });
  assert.equal(
    parseBluepillowPriceBreakdown({
      ...agoda,
      deeplink_url:
        "https://www.bluepillow.com/skippy?connectorname=Agoda&TotalPrice=397.33&TotalTax=39.73",
    }),
    null,
  );
  assert.equal(
    parseBluepillowPriceBreakdown(property().offers[0]),
    null,
  );
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

test("publishes a Bluepillow match only after the validate endpoint confirms it", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/destinations/resolve")) {
      return Response.json({
        candidates: [{
          id: "dest_benidorm",
          name: "Benidorm",
          display_name: "Benidorm",
          type: "city",
          country_code: "ES",
        }],
      });
    }
    if (url.endsWith("/search/stays")) {
      return Response.json({
        results: [property()],
        metadata: { price_as_of: "2026-07-30T08:00:00Z" },
      });
    }
    if (url.endsWith("/validate")) {
      return Response.json({ still_valid: true });
    }
    return Response.json({}, { status: 404 });
  };

  const result = await scrapeBluepillowSource(search(), "agoda", {
    disableCache: true,
    fetchImpl,
  });
  assert.equal(calls.filter((url) => url.endsWith("/validate")).length, 1);
  assert.equal(result.matchingOffers.length, 1);
  assert.equal(result.matchingOffers[0].priceVerified, true);
  assert.equal(result.matchingOffers[0].priceConfirmationCount, 2);
});

test("uses a refreshed Bluepillow price when it still matches", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/destinations/resolve")) {
      return Response.json({
        candidates: [{
          id: "dest_benidorm",
          name: "Benidorm",
          display_name: "Benidorm",
          type: "city",
          country_code: "ES",
        }],
      });
    }
    if (url.endsWith("/search/stays")) {
      return Response.json({ results: [property()], metadata: {} });
    }
    if (url.endsWith("/validate")) {
      return Response.json({
        still_valid: false,
        reason: "price_changed",
        refreshed_offer: { ota: "Agoda", amount: 449, currency: "EUR" },
      });
    }
    return Response.json({}, { status: 404 });
  };

  const result = await scrapeBluepillowSource(search(), "agoda", {
    disableCache: true,
    fetchImpl,
  });
  assert.equal(result.matchingOffers.length, 1);
  assert.equal(result.matchingOffers[0].totalPrice, 449);
  assert.equal(result.matchingOffers[0].nightlyPrice, 112.25);
  assert.equal(result.matchingOffers[0].firstObservedPrice, 437.06);
  assert.equal(result.matchingOffers[0].priceChangedDuringConfirmation, true);
});

test("drops a refreshed Bluepillow price above the budget", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/destinations/resolve")) {
      return Response.json({
        candidates: [{
          id: "dest_benidorm",
          name: "Benidorm",
          display_name: "Benidorm",
          type: "city",
          country_code: "ES",
        }],
      });
    }
    if (url.endsWith("/search/stays")) {
      return Response.json({ results: [property()], metadata: {} });
    }
    if (url.endsWith("/validate")) {
      return Response.json({
        still_valid: false,
        reason: "price_changed",
        refreshed_offer: { ota: "Agoda", amount: 560, currency: "EUR" },
      });
    }
    return Response.json({}, { status: 404 });
  };

  const result = await scrapeBluepillowSource(search(), "agoda", {
    disableCache: true,
    fetchImpl,
  });
  assert.equal(result.matchingOffers.length, 0);
});

test("publishes Trip.com only with the total read from its final page", async () => {
  const target =
    "https://us.trip.com/hotels/list/searchresults?hotelid=123" +
    "&checkin=2026-08-05&checkout=2026-08-09&adult=2&curr=EUR";
  const tripProperty = property({
    offers: [{
      ota: "TripCom",
      amount: 567,
      amount_per_night: 141.75,
      currency: "EUR",
      refundable: true,
      breakfast_included: false,
      deeplink_url:
        `https://www.bluepillow.com/skippy?redirecturl=${encodeURIComponent(target)}` +
        "&begin=2026-08-05&end=2026-08-09&connectorname=TripCom&display=inctotal",
    }],
  });
  const fetchImpl = async (url) => {
    if (url.endsWith("/destinations/resolve")) {
      return Response.json({
        candidates: [{
          id: "dest_benidorm",
          name: "Benidorm",
          display_name: "Benidorm",
          type: "city",
          country_code: "ES",
        }],
      });
    }
    if (url.endsWith("/search/stays")) {
      return Response.json({
        results: [tripProperty],
        metadata: { price_as_of: "2026-08-10T19:00:00Z" },
      });
    }
    if (url.endsWith("/validate")) {
      return Response.json({ still_valid: true });
    }
    return Response.json({}, { status: 404 });
  };
  const providerFetchImpl = async (url) => {
    assert.equal(url, target);
    return new Response(
      String.raw`\"priceDetail\":{\"priceInfo\":{\"totalPrice\":{\"title\":\"Total\",\"content\":\"€590.00\"}}}`,
    );
  };

  const result = await scrapeBluepillowSource(
    search({ maxTotal: 600 }),
    "trip",
    { disableCache: true, fetchImpl, providerFetchImpl },
  );
  assert.equal(result.matchingOffers.length, 1);
  assert.equal(result.matchingOffers[0].totalPrice, 590);
  assert.equal(result.matchingOffers[0].nightlyPrice, 147.5);
  assert.equal(result.matchingOffers[0].provider, "Trip.com");
  assert.equal(
    result.matchingOffers[0].priceBasis,
    "trip_direct_final_total_v1",
  );
  assert.equal(result.matchingOffers[0].url, target);
});
