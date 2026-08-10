const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildGoogleHotelsSearchUrl,
  buildGoogleOffer,
  googleProviderCanSupplyVerifiedTotal,
  parseGoogleGuestRating,
  parseGoogleHotelsNightly,
  parseGoogleHotelsNights,
  parseGoogleProviderInclusiveTotal,
  parseGoogleProviderVisibleTotal,
  parseGoogleHotelsTotal,
  parseGoogleStars,
  providerLinkMatchesStay,
  stableOfferId,
  verifiedGoogleProviderPrice,
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

test("reads only explicit all-inclusive EUR totals from Google providers", () => {
  const providerUrl =
    "https://www.google.com/travel/lodging/clk?" +
    "pcurl=https%3A%2F%2Fwww.super.com%2Ftravel%2Ftransition%2F%3F" +
    "currency%253DEUR%2526total_price%253D209.22%2526" +
    "display_all_inclusive_price%253D227.46%2526" +
    "checkin_at%253D2026-08-05%2526checkout_at%253D2026-08-09";
  assert.equal(parseGoogleProviderInclusiveTotal(providerUrl), 227.46);
  assert.equal(
    parseGoogleProviderInclusiveTotal(
      "https://provider.test/?currency=USD&display_all_inclusive_price=90",
    ),
    0,
  );
  assert.equal(
    parseGoogleProviderInclusiveTotal(
      "https://provider.test/?currency=EUR&total_price=90",
    ),
    0,
  );
  assert.equal(
    parseGoogleProviderInclusiveTotal(
      "https://www.google.com/travel/lodging/clk?" +
        "pcurl=https%3A%2F%2Fwww.bluepillow.es%2Fsearch%2Foffer%3F" +
        "begin%253D2026-08-05%2526end%253D2026-08-09%2526" +
        "tax%253D30.18%2526total%253D332.00%2526currency%253DEUR",
    ),
    332,
  );
  assert.equal(
    parseGoogleProviderInclusiveTotal(
      "https://tripening.example/offer?currency=EUR&tax=30.18&total=1.08",
    ),
    0,
  );
  assert.equal(
    parseGoogleProviderInclusiveTotal(
      "https://mandarinoriental.example/offer?currency=EUR&" +
        "checkin_at=2026-08-05&checkout_at=2026-08-09&" +
        "display_all_inclusive_price=1.32",
    ),
    0,
  );
});

test("reads taxed totals exposed by known Google Hotels partners", () => {
  const booking =
    "https://www.booking.com/searchresults.es.html?checkin=2026-08-05&" +
    "checkout=2026-08-09&selected_currency=EUR&ext_price_total=148.20&" +
    "ext_price_tax=18.20&group_adults=2&group_children=0&no_rooms=1";
  const agoda =
    "https://www.agoda.com/partners/partnersearch.aspx?CkInDay=5&" +
    "CkInMonth=8&CkInYear=2026&CkOutDay=9&CkOutMonth=8&" +
    "CkOutYear=2026&Currency=EUR&PriceTotal=151.00&PriceTax=21.00&" +
    "NumberOfAdults=2&NumberOfChildren=0&NumberOfRooms=1";
  const trivago =
    "https://www.trivago.deals/hotels/test?checkIn=2026-08-05&" +
    "checkOut=2026-08-09&currencyCode=EUR&priceDisplayedTotal=149.90&" +
    "priceDisplayedTax=19.90&adults=2&children=0";
  const expedia =
    "https://www.expedia.com/Hotel-Search?startDate=2026-08-05&" +
    "endDate=2026-08-09&currency=EUR&mpa=130.00&mpb=18.25&" +
    "adults=2";

  assert.equal(parseGoogleProviderInclusiveTotal(booking), 148.2);
  assert.equal(parseGoogleProviderInclusiveTotal(agoda), 151);
  assert.equal(parseGoogleProviderInclusiveTotal(trivago), 149.9);
  assert.equal(parseGoogleProviderInclusiveTotal(expedia), 148.25);
  assert.equal(
    parseGoogleProviderInclusiveTotal(
      "https://www.booking.com/search?currency=EUR&ext_price_total=1.00",
    ),
    0,
  );
});

test("requires the exact Google provider stay and occupancy", () => {
  const familySearch = search({ children: 2 });
  const exact =
    "https://www.super.com/travel?checkin_at=2026-08-05&" +
    "checkout_at=2026-08-09&num_adults=2&children=%5B7%2C7%5D";
  assert.equal(providerLinkMatchesStay(exact, familySearch), true);
  assert.equal(
    providerLinkMatchesStay(exact.replace("%5B7%2C7%5D", "%5B7%5D"), familySearch),
    false,
  );
  assert.equal(
    providerLinkMatchesStay(exact.replace("2026-08-09", "2026-08-10"), familySearch),
    false,
  );
});

test("reads the final taxed total from the current Google provider row", () => {
  assert.equal(
    parseGoogleProviderVisibleTotal(
      "Bluepillow.com\n2 huéspedes · EUR 82 con impuestos + comisiones" +
        "Precio base por nochePrecio por noche con impuestos y comisiones" +
        "Precio total de la estancia con impuestos y comisiones" +
        "EUR 75EUR 75EUR 82EUR 330Visitar sitio web",
    ),
    330,
  );
  assert.equal(
    parseGoogleProviderVisibleTotal(
      "Booking.com\nCancelación gratuita70 €70 €70 €Visitar sitio web",
    ),
    0,
  );
  assert.equal(
    parseGoogleProviderVisibleTotal(
      "Provider 70 US$70 US$70 US$Visit website",
    ),
    0,
  );
  assert.equal(
    parseGoogleProviderVisibleTotal(
      "Booking.comEUR 253 con impuestos + comisiones" +
        "Precio base por nochePrecio por noche con impuestos y comisiones" +
        "Precio total de la estancia con impuestos y comisiones" +
        "EUR 230EUR 230EUR 253EUR 1,012Visitar sitio web",
    ),
    1012,
  );
});

test("accepts Google's explicit final row when its outbound URL omits dates", () => {
  const result = verifiedGoogleProviderPrice(
    {
      href: "https://provider.test/offer",
      text:
        "Bluepillow.com\n4 huespedes, EUR 104 con impuestos + comisiones" +
        "Precio base por nochePrecio por noche con impuestos y comisiones" +
        "Precio total de la estancia con impuestos y comisiones" +
        "EUR 95EUR 95EUR 104EUR 313Visitar sitio web",
    },
    search({ adults: 2, children: 2 }),
  );
  assert.deepEqual(result, {
    totalPrice: 313,
    evidence: "visible_provider_row",
  });
  assert.equal(
    verifiedGoogleProviderPrice(
      {
        href: "https://provider.test/offer",
        text:
          "Bluepillow.com\n2 huespedes" +
          "Precio total de la estancia con impuestos y comisiones" +
          "EUR 313Visitar sitio web",
      },
      search({ adults: 2, children: 2 }),
    ),
    null,
  );
});

test("rejects Tripening technical prices as verified hotel totals", () => {
  assert.equal(
    googleProviderCanSupplyVerifiedTotal(
      "Tripening Hotels\n1,08 EUR\nVisitar sitio web",
    ),
    false,
  );
  assert.equal(
    googleProviderCanSupplyVerifiedTotal(
      "Bluepillow.com\n330,10 EUR\nVisitar sitio web",
    ),
    true,
  );
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
  assert.equal(offer.priceBasis, "google_hotels_visible_all_inclusive_v6");
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
