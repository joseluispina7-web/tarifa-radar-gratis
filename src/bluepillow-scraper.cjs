const crypto = require("node:crypto");
const {
  detectAmenities,
  detectMealPlan,
  distanceBetweenCoordinates,
  isSharedRoomText,
  matchesSearch,
  normalizeSearch,
} = require("./booking-scraper.cjs");

const BLUEPILLOW_API_URL = "https://api.b2a.bluepillow.com/v1";
const BLUEPILLOW_SOURCE = "bluepillow";
const DEFAULT_TIMEOUT_MS = 30_000;

// Bluepillow documents anonymous keys as public rate-limit identifiers with
// no billing identity. An environment variable can replace this shared key.
const DEFAULT_ANONYMOUS_KEY =
  "pk_anon_5a18e7c55f6933dc5fd2ce98f110e6b54ef07015";

const SOURCE_SETTINGS = {
  agoda: {
    label: "Agoda",
    otaNames: new Set(["agoda"]),
  },
  trip: {
    label: "Trip.com",
    otaNames: new Set(["trip", "tripcom", "trip.com"]),
  },
  bluepillow: {
    label: "Bluepillow",
    otaNames: null,
  },
};

const sharedSearches = new Map();

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeOta(value) {
  return normalizeText(value).replace(/[^a-z0-9.]/g, "");
}

function stableBluepillowOfferId(source, propertyId, checkIn, checkOut) {
  return `${source}:${propertyId}|${checkIn}|${checkOut}`;
}

function sourceSettings(source) {
  const settings = SOURCE_SETTINGS[source];
  if (!settings) throw new Error(`Fuente Bluepillow desconocida: ${source}.`);
  return settings;
}

function chooseDestination(candidates, search) {
  const destinationName = normalizeText(search.destination.split(",")[0]);
  const countryCode = String(search.countryCode || "").toUpperCase();
  const ranked = (candidates || [])
    .filter((candidate) =>
      !countryCode ||
      !candidate.country_code ||
      candidate.country_code === countryCode
    )
    .map((candidate) => {
      const name = normalizeText(candidate.name);
      const displayName = normalizeText(candidate.display_name);
      let score = Number(candidate.confidence) || 0;
      if (name === destinationName) score += 10;
      else if (displayName.startsWith(destinationName)) score += 5;
      if (candidate.type === "city") score += 2;
      return { candidate, score };
    })
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate || null;
}

function linkMatchesStay(value, search) {
  let decoded = String(value || "");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = `${decoded}\n${next}`;
    } catch {
      break;
    }
  }
  const checkInPattern = new RegExp(
    `(?:begin|checkin|check_in|checkIn)=${search.checkIn.replaceAll("-", "[-/]")}`,
    "i",
  );
  const checkOutPattern = new RegExp(
    `(?:end|checkout|check_out|checkOut)=${search.checkOut.replaceAll("-", "[-/]")}`,
    "i",
  );
  return checkInPattern.test(decoded) && checkOutPattern.test(decoded);
}

function mapPropertyType(value) {
  const type = normalizeText(value);
  if (["apartment", "aparthotel", "villa"].includes(type)) return "apartment";
  if (["bnb", "rural"].includes(type)) return "rural";
  if (type === "hostel") return "hostel";
  if (type === "resort") return "resort";
  return "hotel";
}

function mapAmenities(property, selectedOffer) {
  const values = [
    ...(property.amenities || []),
    ...(property.features || []),
  ];
  const text = values.join(" ");
  const amenities = new Set(detectAmenities(text));
  const aliases = [
    ["pool", /pool|piscina/],
    ["spa", /\bspa\b|sauna/],
    ["parking", /parking|aparcamiento/],
    ["beach", /beach|playa|oceanfront/],
    ["pets", /pet|mascota/],
    ["air_conditioning", /air.?conditioning|aire.?acondicionado/],
    ["family_rooms", /family.?room|habitacion.?familiar/],
    ["all_inclusive", /all.?inclusive|todo.?incluido/],
    ["gym", /gym|fitness|gimnasio/],
  ];
  for (const [amenity, pattern] of aliases) {
    if (pattern.test(normalizeText(text))) amenities.add(amenity);
  }
  if (selectedOffer.breakfast_included) amenities.add("breakfast");
  return Array.from(amenities);
}

function findSelectedOffer(property, source) {
  const settings = sourceSettings(source);
  const offers = (property.offers || []).filter(
    (offer) =>
      offer &&
      offer.currency === "EUR" &&
      Number(offer.amount) > 0 &&
      offer.deeplink_url
  );
  if (settings.otaNames) {
    return offers
      .filter((offer) => settings.otaNames.has(normalizeOta(offer.ota)))
      .sort((left, right) => Number(left.amount) - Number(right.amount))[0] ||
      null;
  }

  return offers.sort(
    (left, right) => Number(left.amount) - Number(right.amount),
  )[0] || null;
}

function buildBluepillowOffer(property, search, source, metadata = {}) {
  const settings = sourceSettings(source);
  const selectedOffer = findSelectedOffer(property, source);
  const totalPrice = Number(selectedOffer?.amount);
  const displayedNightlyPrice = Number(selectedOffer?.amount_per_night);
  const calculatedNightlyPrice =
    Math.round((totalPrice / search.nights) * 100) / 100;
  const consistentNightly =
    displayedNightlyPrice > 0 &&
    Math.abs(displayedNightlyPrice * search.nights - totalPrice) <=
      Math.max(0.08, search.nights * 0.02);
  const exactStayLink = linkMatchesStay(
    selectedOffer?.deeplink_url || property.web_url,
    search,
  );
  if (
    !property.id ||
    !property.name ||
    property.availability_status !== "available" ||
    !selectedOffer ||
    !Number.isFinite(totalPrice) ||
    totalPrice <= 0 ||
    selectedOffer.currency !== "EUR" ||
    !consistentNightly ||
    !exactStayLink
  ) {
    return null;
  }

  const latitude = Number(property.location?.lat);
  const longitude = Number(property.location?.lon);
  const hasCoordinates =
    Number.isFinite(latitude) && Number.isFinite(longitude);
  const distanceKm =
    hasCoordinates &&
    search.originLatitude !== null &&
    search.originLongitude !== null
      ? distanceBetweenCoordinates(
          search.originLatitude,
          search.originLongitude,
          latitude,
          longitude,
        )
      : null;
  const otaLabel =
    normalizeOta(selectedOffer.ota) === "tripcom"
      ? "Trip.com"
      : String(selectedOffer.ota || settings.label);
  const addressParts = [
    property.location?.address &&
    normalizeText(property.location.address) !== "unknown"
      ? property.location.address
      : "",
    property.location?.city,
  ].filter(Boolean);
  const amenities = mapAmenities(property, selectedOffer);
  const mealPlan = selectedOffer.breakfast_included
    ? "breakfast"
    : detectMealPlan((property.features || []).join(" "));
  const offer = {
    id: stableBluepillowOfferId(
      source,
      property.id,
      search.checkIn,
      search.checkOut,
    ),
    source,
    provider:
      source === BLUEPILLOW_SOURCE
        ? `${otaLabel} via Bluepillow`
        : `${settings.label} via Bluepillow`,
    hotelName: String(property.name).trim(),
    address: addressParts.join(", ") || search.searchArea,
    checkIn: search.checkIn,
    checkOut: search.checkOut,
    nights: search.nights,
    totalPrice,
    nightlyPrice: calculatedNightlyPrice,
    displayedNightlyPrice,
    rateSubtotal: totalPrice,
    searchResultPrice: totalPrice,
    additionalCharges: 0,
    taxesText: `Total en EUR publicado por Bluepillow para ${otaLabel}`,
    stayText: `${search.nights} noches para ${search.adults} adultos`,
    priceVerified: true,
    priceBasis: "bluepillow_live_stay_total",
    priceConfirmationCount: 2,
    priceConfirmedAt: metadata.price_as_of || new Date().toISOString(),
    stars: Number(property.stars) || 0,
    guestRating: Math.round((Number(property.rating) || 0) * 20) / 10,
    reviewCount:
      Number(property.rating_count) ||
      Number(property.reviews_aggregate?.rating_count) ||
      0,
    distanceKm,
    freeCancellation: selectedOffer.refundable === true,
    breakfastIncluded: selectedOffer.breakfast_included === true,
    limitedAvailability:
      Number(selectedOffer.rooms_left) > 0 &&
      Number(selectedOffer.rooms_left) <= 2,
    propertyType: mapPropertyType(property.property_type),
    amenities,
    mealPlan,
    roomName: "",
    sharedRoom: isSharedRoomText(
      `${property.name} ${(property.features || []).join(" ")}`,
    ),
    searchArea: search.searchArea,
    url: selectedOffer.deeplink_url || property.web_url,
    imageUrl: property.thumbnail_url || "",
  };
  offer.matches = matchesSearch(offer, search);
  offer.candidateMatches = offer.matches;
  return offer;
}

async function requestJson(pathname, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const apiKey =
    options.apiKey ||
    process.env.BLUEPILLOW_API_KEY ||
    DEFAULT_ANONYMOUS_KEY;
  const response = await fetchImpl(`${BLUEPILLOW_API_URL}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(options.idempotent
        ? { "idempotency-key": crypto.randomUUID() }
        : {}),
    },
    body: JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload.error?.message ||
      `Bluepillow respondio ${response.status}.`,
    );
  }
  return payload;
}

async function fetchBluepillowSearch(search, options = {}) {
  const destinationName = search.destination.split(",")[0].trim();
  const resolution = await requestJson("/destinations/resolve", {
    ...options,
    body: {
      name: destinationName,
      ...(search.countryCode ? { country: search.countryCode } : {}),
      language: "es",
    },
  });
  const destination = chooseDestination(resolution.candidates, search);
  if (!destination) {
    throw new Error(
      `Bluepillow no reconocio el destino ${destinationName}.`,
    );
  }

  const payload = await requestJson("/search/stays", {
    ...options,
    idempotent: true,
    body: {
      location: {
        type: "destination_id",
        value: destination.id,
      },
      dates: {
        check_in: search.checkIn,
        check_out: search.checkOut,
      },
      guests: {
        adults: search.adults,
        children_ages: Array.from(
          { length: search.children },
          () => 7,
        ),
        rooms: search.rooms,
      },
      sort: "price_asc",
      page: {
        limit: Math.min(100, Math.max(30, search.maxResults)),
      },
      user_country: search.countryCode || "ES",
      language: "es",
      currency: "EUR",
    },
  });
  return {
    destination,
    metadata: payload.metadata || {},
    properties: payload.results || [],
  };
}

function searchCacheKey(search) {
  return JSON.stringify([
    search.destination,
    search.countryCode,
    search.checkIn,
    search.checkOut,
    search.adults,
    search.children,
    search.rooms,
    search.maxResults,
  ]);
}

async function sharedBluepillowSearch(search, options) {
  if (options.fetchImpl || options.disableCache) {
    return fetchBluepillowSearch(search, options);
  }
  const key = searchCacheKey(search);
  if (!sharedSearches.has(key)) {
    const pending = fetchBluepillowSearch(search, options).catch((error) => {
      sharedSearches.delete(key);
      throw error;
    });
    sharedSearches.set(key, pending);
  }
  return sharedSearches.get(key);
}

async function scrapeBluepillowSource(input, source, options = {}) {
  const search = normalizeSearch(input);
  sourceSettings(source);
  const result = await sharedBluepillowSearch(search, options);
  const offers = result.properties
    .slice(0, search.maxResults)
    .map((property) =>
      buildBluepillowOffer(property, search, source, result.metadata)
    )
    .filter(Boolean);
  const matchingOffers = offers
    .filter((offer) => offer.matches)
    .sort((left, right) => left.totalPrice - right.totalPrice);
  return {
    source,
    searchedAt: result.metadata.price_as_of || new Date().toISOString(),
    search,
    searchUrl:
      `https://www.bluepillow.es/search?begin=${search.checkIn}` +
      `&end=${search.checkOut}&destination=${encodeURIComponent(search.destination)}`,
    searchedPages: 1,
    offers,
    matchingOffers,
    verificationErrors: [],
    cheapestOffer:
      offers
        .slice()
        .sort((left, right) => left.totalPrice - right.totalPrice)[0] ||
      null,
  };
}

function scrapeAgoda(input, options = {}) {
  return scrapeBluepillowSource(input, "agoda", options);
}

function scrapeTrip(input, options = {}) {
  return scrapeBluepillowSource(input, "trip", options);
}

function scrapeBluepillow(input, options = {}) {
  return scrapeBluepillowSource(input, BLUEPILLOW_SOURCE, options);
}

module.exports = {
  BLUEPILLOW_SOURCE,
  buildBluepillowOffer,
  chooseDestination,
  findSelectedOffer,
  linkMatchesStay,
  mapAmenities,
  mapPropertyType,
  normalizeOta,
  scrapeAgoda,
  scrapeBluepillow,
  scrapeBluepillowSource,
  scrapeTrip,
  stableBluepillowOfferId,
};
