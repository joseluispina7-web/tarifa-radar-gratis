const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildBookingPageUrls,
  buildBookingSearchUrl,
  calculateVerifiedTableTotal,
  detectAmenities,
  detectMealPlan,
  detectPropertyType,
  distanceBetweenCoordinates,
  fallbackTaxRateForCountry,
  isSharedRoomText,
  matchesSearch,
  nightsBetween,
  normalizeSearch,
  parseAdditionalCharges,
  parseBookingBlockIds,
  parseBookingRateTotal,
  parseDistanceKm,
  parseEuroPrice,
  parseReviewCount,
  parseReviewScore,
  parseStars,
  stayMatchesSearch,
} = require("../src/booking-scraper.cjs");
const { compareWithState } = require("../src/state.cjs");
const {
  buildMonitorScanRequests,
  buildMonitorSearches,
  monitorIsDue,
  monitorToSearch,
} = require("../src/remote-scan.cjs");

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

test("uses the exact stay total encoded in Booking rate blocks", () => {
  assert.equal(
    parseBookingRateTotal(
      "https://www.booking.com/hotel/es/example.es.html?sr_pri_blocks=123_4_2_0_0__42570",
    ),
    425.7,
  );
  assert.equal(
    parseBookingRateTotal(
      "https://www.booking.com/hotel/es/example.es.html?sr_pri_blocks=123__26000%2C123__26000",
    ),
    520,
  );
  assert.equal(parseAdditionalCharges("+ € 18 de impuestos y cargos"), 18);
  assert.equal(parseAdditionalCharges("Incluye impuestos y cargos"), 0);
});

test("checks additional Booking pages when a surrounding radius is selected", () => {
  const urls = buildBookingPageUrls({
    ...searchInput,
    maxDistanceKm: 5,
    maxResults: 75,
  }).map((value) => new URL(value));
  assert.equal(urls.length, 3);
  assert.equal(urls[0].searchParams.has("offset"), false);
  assert.equal(urls[1].searchParams.get("offset"), "25");
  assert.equal(urls[2].searchParams.get("offset"), "50");
  assert.equal(buildBookingPageUrls(searchInput).length, 1);
});

test("reads the exact room block ids from a Booking result", () => {
  assert.deepEqual(
    parseBookingBlockIds(
      "https://www.booking.com/hotel/es/example.es.html?all_sr_blocks=room-a%2Croom-a",
    ),
    ["room-a", "room-a"],
  );
  assert.deepEqual(
    parseBookingBlockIds(
      "https://www.booking.com/hotel/es/example.es.html?matching_block_id=room-b",
    ),
    ["room-b"],
  );
});

test("accepts only bookable table totals with taxes accounted for", () => {
  const included = [
    {
      blockId: "room-a",
      priceText: "€ 426",
      taxesText: "Incluye impuestos y cargos",
    },
  ];
  assert.equal(calculateVerifiedTableTotal(["room-a"], included), 426);
  assert.equal(
    calculateVerifiedTableTotal(["room-a", "room-a"], included),
    852,
  );
  assert.equal(
    calculateVerifiedTableTotal(
      ["room-b"],
      [{
        blockId: "room-b",
        priceText: "€ 400",
        taxesText: "+ € 40 de impuestos y cargos",
      }],
    ),
    440,
  );
  assert.equal(
    calculateVerifiedTableTotal(
      ["room-c"],
      [{ blockId: "room-c", priceText: "€ 350", taxesText: "" }],
    ),
    0,
  );
  assert.equal(
    calculateVerifiedTableTotal(
      ["room-c"],
      [{ blockId: "room-c", priceText: "€ 387", taxesText: "" }],
      { fallbackTaxRate: fallbackTaxRateForCountry("ES") },
    ),
    425.7,
  );
  assert.equal(fallbackTaxRateForCountry("ES"), 0.1);
  assert.equal(fallbackTaxRateForCountry("FR"), 0);
});

test("rejects a card when its stay does not match the requested search", () => {
  const search = normalizeSearch(searchInput);
  assert.equal(stayMatchesSearch("4 noches, 2 adultos", search), true);
  assert.equal(stayMatchesSearch("1 noche, 2 adultos", search), false);
  assert.equal(stayMatchesSearch("4 noches, 1 adulto", search), false);
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

test("keeps a configurable safety margin below the budget", () => {
  const search = normalizeSearch({
    ...searchInput,
    maxTotal: 100,
    maxNightly: 0,
    priceSafetyPercent: 5,
  });
  const offer = {
    totalPrice: 95,
    nightlyPrice: 23.75,
    stars: 0,
    guestRating: 8,
    freeCancellation: false,
    sharedRoom: false,
  };
  assert.equal(matchesSearch(offer, search), true);
  assert.equal(
    matchesSearch({ ...offer, totalPrice: 95.01 }, search),
    false,
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

test("extracts useful card details for panel filters", () => {
  const text =
    "Hostal junto a la playa con piscina, parking y desayuno incluido";
  assert.equal(detectPropertyType(text), "hostel");
  assert.deepEqual(detectAmenities(text), [
    "pool",
    "parking",
    "beach",
    "breakfast",
  ]);
  assert.equal(detectMealPlan(text), "breakfast");
  assert.equal(parseDistanceKm("A 750 m del centro"), 0.75);
  assert.equal(parseDistanceKm("A 2,4 km del centro"), 2.4);
  assert.equal(
    parseDistanceKm("Finestrat · A 4,8 km de Benidorm", "Benidorm, España"),
    4.8,
  );
  assert.equal(
    parseDistanceKm("A 5,4 km de Terra Natura", "Benidorm, España"),
    0,
  );
});

test("applies distance, property, meal and amenity filters", () => {
  const filteredSearch = normalizeSearch({
    ...searchInput,
    maxDistanceKm: 3,
    propertyTypes: ["hotel"],
    mealPlan: "breakfast",
    amenities: ["pool", "parking"],
  });
  const matchingOffer = {
    totalPrice: 120,
    nightlyPrice: 30,
    stars: 0,
    guestRating: 8,
    distanceKm: 2.4,
    freeCancellation: false,
    mealPlan: "breakfast",
    propertyType: "hotel",
    amenities: ["breakfast", "pool", "parking"],
    sharedRoom: false,
  };
  assert.equal(matchesSearch(matchingOffer, filteredSearch), true);
  assert.equal(
    matchesSearch({ ...matchingOffer, distanceKm: 0 }, filteredSearch),
    true,
  );
  assert.equal(
    matchesSearch({ ...matchingOffer, distanceKm: null }, filteredSearch),
    false,
  );
  assert.equal(
    matchesSearch(
      { ...matchingOffer, distanceKm: null },
      filteredSearch,
      { ignoreDistance: true },
    ),
    true,
  );
  assert.equal(
    matchesSearch(
      { ...matchingOffer, distanceKm: 40 },
      filteredSearch,
      { ignoreDistance: true },
    ),
    true,
  );
  assert.equal(
    matchesSearch({ ...matchingOffer, distanceKm: 4 }, filteredSearch),
    false,
  );
  assert.equal(
    matchesSearch({ ...matchingOffer, propertyType: "hostel" }, filteredSearch),
    false,
  );
  assert.equal(
    matchesSearch(
      { ...matchingOffer, amenities: ["breakfast", "pool"] },
      filteredSearch,
    ),
    false,
  );
});

test("turns panel monitors into fixed or rotating exact searches", () => {
  const now = new Date("2026-07-29T00:00:00Z");
  assert.deepEqual(
    buildMonitorSearches(
      {
        id: 1,
        dateMode: "fixed",
        dateStart: "2026-08-23",
        dateEnd: "2026-08-27",
      },
      now,
    ),
    [{ checkIn: "2026-08-23", checkOut: "2026-08-27" }],
  );

  const searches = buildMonitorSearches(
    {
      id: 2,
      dateMode: "flexible",
      windowDays: 90,
      minNights: 4,
      maxNights: 7,
    },
    now,
  );
  assert.equal(searches.length, 2);
  assert.notDeepEqual(searches[0], searches[1]);

  const search = monitorToSearch(
    {
      id: 2,
      name: "Madrid",
      location: "Madrid",
      latitude: 40.4168,
      longitude: -3.7038,
      adults: 2,
      children: 0,
      rooms: 1,
      maxTotal: 150,
      maxNightly: 30,
      priceMatch: "both",
      minStars: 0,
      guestRatingMin: 0,
      maxDistanceKm: 5,
      freeCancellation: false,
    },
    searches[0],
  );
  assert.equal(search.priceRule, "and");
  assert.equal(search.maxResults, 25);
  assert.equal(search.priceSafetyPercent, 5);
  assert.equal(search.originLatitude, 40.4168);
  assert.equal(search.originLongitude, -3.7038);
  assert.equal(monitorIsDue({ intervalMinutes: 5, lastScanAt: null }, now), true);
  assert.equal(
    monitorIsDue(
      { intervalMinutes: 15, lastScanAt: "2026-07-28 23:55:00" },
      now,
    ),
    false,
  );
});

test("rotates one nearby area without multiplying every flexible stay", () => {
  const now = new Date("2026-07-29T00:00:00Z");
  const nearby = [
    { name: "Finestrat", query: "Finestrat, España" },
    { name: "La Nucia", query: "La Nucia, España" },
  ];
  const fixed = buildMonitorScanRequests(
    {
      id: "benidorm",
      location: "Benidorm, España",
      dateMode: "fixed",
      dateStart: "2026-08-05",
      dateEnd: "2026-08-09",
    },
    nearby,
    now,
  );
  assert.equal(fixed.length, 3);
  assert.equal(fixed[0].area.isNearby, false);
  assert.equal(fixed[1].area.isNearby, true);
  assert.equal(fixed[2].area.isNearby, true);

  const flexible = buildMonitorScanRequests(
    {
      id: "alicante",
      location: "Alicante, España",
      dateMode: "flexible",
      windowDays: 90,
      minNights: 1,
      maxNights: 4,
    },
    nearby,
    now,
  );
  assert.equal(flexible.length, 2);
});

test("calculates the real distance between destination and hotel coordinates", () => {
  const distance = distanceBetweenCoordinates(
    38.53816,
    -0.13098,
    38.5386298,
    -0.1317479,
  );
  assert.ok(distance > 0.08 && distance < 0.09);
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
