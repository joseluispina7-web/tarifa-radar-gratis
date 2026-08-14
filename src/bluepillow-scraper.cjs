const crypto = require("node:crypto");
const {
  detectAmenities,
  detectMealPlan,
  distanceBetweenCoordinates,
  effectiveDistanceLimit,
  isSharedRoomText,
  matchesSearch,
  normalizeSearch,
  parseEuroPrice,
} = require("./booking-scraper.cjs");

const BLUEPILLOW_API_URL = "https://api.b2a.bluepillow.com/v1";
const BLUEPILLOW_SOURCE = "bluepillow";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_VALIDATIONS_PER_SEARCH = 2;

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
const sharedValidations = new Map();
const validationBudgets = new Map();

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

function decodedLinkValues(value) {
  const values = [String(value || "")];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const decoded = decodeURIComponent(values.at(-1));
      if (decoded === values.at(-1)) break;
      values.push(decoded);
    } catch {
      break;
    }
  }
  return values;
}

function providerRedirectUrl(value) {
  try {
    const redirectUrl = new URL(value).searchParams.get("redirecturl");
    return redirectUrl ? new URL(redirectUrl).toString() : "";
  } catch {
    return "";
  }
}

function parseTripFinalTotal(value) {
  const normalized = String(value || "")
    .replaceAll('\\"', '"')
    .replaceAll("\\u20ac", "€");
  const priceDetail = normalized.match(
    /"priceDetail":\{[\s\S]{0,2500}?"priceInfo":\{"totalPrice":\{"title":"Total","content":"(€\s*[\d.,]+)"/i,
  );
  return priceDetail ? parseEuroPrice(priceDetail[1]) : 0;
}

function linkNumber(values, parameter) {
  const pattern = new RegExp(`(?:[?&]|%26)${parameter}=([\\d.,]+)`, "i");
  for (const value of values.slice().reverse()) {
    const match = value.match(pattern);
    if (!match) continue;
    const number = Number(match[1].replace(",", "."));
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function linkText(values, parameter) {
  const pattern = new RegExp(`(?:[?&]|%26)${parameter}=([^&\\s]+)`, "i");
  for (const value of values.slice().reverse()) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function pricesAreEqual(left, right) {
  return Math.abs(Number(left) - Number(right)) <= 0.03;
}

function parseBluepillowPriceBreakdown(offer) {
  const totalPrice = Number(offer?.amount);
  if (!Number.isFinite(totalPrice) || totalPrice <= 0) return null;

  const values = decodedLinkValues(offer.deeplink_url);
  const ota = normalizeOta(offer.ota);
  if (ota === "agoda") {
    const linkedTotal = linkNumber(values, "TotalPrice");
    if (!pricesAreEqual(linkedTotal, totalPrice)) return null;
    const includedTaxes = linkNumber(values, "TotalTax");
    const includedFees =
      linkNumber(values, "TotalFee") +
      linkNumber(values, "TotalSurcharge");
    return {
      totalPrice,
      includedTaxes,
      includedFees,
      evidence: "agoda_total_with_tax_breakdown",
    };
  }

  if (ota === "trip" || ota === "tripcom" || ota === "trip.com") {
    if (normalizeText(linkText(values, "display")) !== "inctotal") return null;
    return {
      totalPrice,
      includedTaxes: 0,
      includedFees: 0,
      evidence: "trip_inclusive_total",
    };
  }

  if (ota === "expedia") {
    const basePrice = linkNumber(values, "mpa");
    const includedTaxes = linkNumber(values, "mpb");
    if (
      basePrice <= 0 ||
      includedTaxes < 0 ||
      !pricesAreEqual(basePrice + includedTaxes, totalPrice)
    ) {
      return null;
    }
    return {
      totalPrice,
      includedTaxes,
      includedFees: 0,
      evidence: "expedia_total_with_tax_breakdown",
    };
  }

  const allInclusiveTotal =
    linkNumber(values, "display_all_inclusive_price") ||
    linkNumber(values, "all_inclusive_price") ||
    linkNumber(values, "grand_total") ||
    linkNumber(values, "total_including_taxes") ||
    linkNumber(values, "total_with_taxes");
  if (!pricesAreEqual(allInclusiveTotal, totalPrice)) return null;
  return {
    totalPrice,
    includedTaxes: 0,
    includedFees: 0,
    evidence: "explicit_inclusive_total",
  };
}

function stableBluepillowOfferId(source, propertyId, checkIn, checkOut) {
  return `${source}:${propertyId}|${checkIn}|${checkOut}`;
}

function sourceSettings(source) {
  const settings = SOURCE_SETTINGS[source];
  if (!settings) throw new Error(`Fuente Bluepillow desconocida: ${source}.`);
  return settings;
}

function candidateCountryCode(candidate) {
  const direct = String(candidate?.country_code || "").toUpperCase();
  if (/^[A-Z]{2}$/.test(direct)) return direct;
  const breadcrumb = Array.isArray(candidate?.path_breadcrumb)
    ? candidate.path_breadcrumb
    : [];
  const inferred = String(breadcrumb[0] || "").toUpperCase();
  return /^[A-Z]{2}$/.test(inferred) ? inferred : "";
}

function candidateDistanceKm(candidate, search) {
  const latitude = Number(candidate?.location?.lat);
  const longitude = Number(candidate?.location?.lon);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(Number(search.originLatitude)) ||
    !Number.isFinite(Number(search.originLongitude))
  ) {
    return null;
  }
  return distanceBetweenCoordinates(
    Number(search.originLatitude),
    Number(search.originLongitude),
    latitude,
    longitude,
  );
}

function chooseDestination(candidates, search) {
  const destinationName = normalizeText(search.destination.split(",")[0]);
  const countryCode = String(search.countryCode || "").toUpperCase();
  const ranked = (candidates || [])
    .filter((candidate) => {
      const candidateCountry = candidateCountryCode(candidate);
      return !countryCode || !candidateCountry || candidateCountry === countryCode;
    })
    .map((candidate) => {
      const name = normalizeText(candidate.name);
      const displayName = normalizeText(candidate.display_name);
      const distanceKm = candidateDistanceKm(candidate, search);
      let score = Number(candidate.confidence) || 0;
      if (name === destinationName) score += 10;
      else if (displayName.startsWith(destinationName)) score += 5;
      if (candidate.type === "city") score += 2;
      if (distanceKm !== null) score += Math.max(0, 5 - distanceKm / 5);
      return { candidate, distanceKm, score };
    })
    .filter(({ distanceKm }) => distanceKm === null || distanceKm <= 100)
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate || null;
}

function coordinateSearchLocation(search) {
  const latitude = Number(search.originLatitude);
  const longitude = Number(search.originLongitude);
  const radius = effectiveDistanceLimit(search);
  if (
    radius <= 0 ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }
  return {
    type: "coordinates",
    value: {
      lat: latitude,
      lon: longitude,
      radius,
    },
  };
}

function bluepillowSearchFilters(search) {
  const safetyMultiplier = 1 - Number(search.priceSafetyPercent || 0) / 100;
  const priceLimits = [];
  if (Number(search.maxTotal) > 0) {
    priceLimits.push(Number(search.maxTotal) * safetyMultiplier);
  }
  if (Number(search.maxNightly) > 0) {
    priceLimits.push(
      Number(search.maxNightly) * Number(search.nights) * safetyMultiplier,
    );
  }
  const priceLimit = priceLimits.length
    ? search.priceRule === "and"
      ? Math.min(...priceLimits)
      : Math.max(...priceLimits)
    : 0;
  const filters = {
    ...(priceLimit > 0 ? { price_max_eur: Math.round(priceLimit * 100) / 100 } : {}),
    ...(search.propertyTypes.length
      ? { property_types: search.propertyTypes }
      : {}),
    ...(search.amenities.length ? { amenities: search.amenities } : {}),
  };
  return Object.keys(filters).length ? filters : null;
}

function linkMatchesStay(value, search) {
  const decoded = decodedLinkValues(value).join("\n");
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
      offer.deeplink_url &&
      parseBluepillowPriceBreakdown(offer)
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
  const priceBreakdown = parseBluepillowPriceBreakdown(selectedOffer);
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
    !priceBreakdown ||
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
    includedTaxesAndFees:
      Math.round(
        (priceBreakdown.includedTaxes + priceBreakdown.includedFees) * 100
      ) / 100,
    taxesText:
      priceBreakdown.includedTaxes + priceBreakdown.includedFees > 0
        ? `Total con ${(
            priceBreakdown.includedTaxes + priceBreakdown.includedFees
          ).toFixed(2)} EUR de impuestos y tasas incluidos`
        : `Total con impuestos y tasas incluidos por ${otaLabel}`,
    stayText: `${search.nights} noches para ${search.adults} adultos`,
    priceVerified: false,
    priceBasis: priceBreakdown.evidence,
    priceConfirmationCount: 0,
    priceConfirmedAt: "",
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
    bluepillowPropertyId: property.id,
    bluepillowOta: selectedOffer.ota,
  };
  offer.matches = matchesSearch(offer, search);
  offer.candidateMatches = offer.matches;
  return offer;
}

function validationCacheKey(offer, search) {
  return JSON.stringify([
    offer.bluepillowPropertyId,
    normalizeOta(offer.bluepillowOta),
    offer.totalPrice,
    search.checkIn,
    search.checkOut,
    search.adults,
    search.children,
    search.rooms,
  ]);
}

async function validateBluepillowOffer(offer, search, options = {}) {
  const searchKey = searchCacheKey(search);
  const key = validationCacheKey(offer, search);
  if (!options.disableCache && sharedValidations.has(key)) {
    return sharedValidations.get(key);
  }

  if (!options.disableCache) {
    const used = validationBudgets.get(searchKey) || 0;
    if (used >= MAX_VALIDATIONS_PER_SEARCH) {
      return {
        valid: false,
        skipped: true,
        message: "No se publico porque alcanzo el limite de revalidaciones.",
      };
    }
    validationBudgets.set(searchKey, used + 1);
  }

  const pending = requestJson("/validate", {
    ...options,
    idempotent: true,
    body: {
      property_id: offer.bluepillowPropertyId,
      dates: {
        check_in: search.checkIn,
        check_out: search.checkOut,
      },
      guests: {
        adults: search.adults,
        children_ages: Array.from({ length: search.children }, () => 7),
        rooms: search.rooms,
      },
      offer_to_compare: {
        ota: offer.bluepillowOta,
        total_eur: offer.totalPrice,
      },
    },
  })
    .then((payload) => {
      if (payload.still_valid === true) {
        return {
          valid: true,
          checkedAt: payload.metadata?.price_as_of || new Date().toISOString(),
        };
      }
      const refreshedPrice = Number(payload.refreshed_offer?.amount);
      const refreshedCurrency = String(
        payload.refreshed_offer?.currency || "EUR",
      ).toUpperCase();
      const refreshedOta = normalizeOta(
        payload.refreshed_offer?.ota || offer.bluepillowOta,
      );
      const canUseRefreshedPrice =
        payload.reason === "price_changed" &&
        Number.isFinite(refreshedPrice) &&
        refreshedPrice > 0 &&
        refreshedCurrency === "EUR" &&
        refreshedOta === normalizeOta(offer.bluepillowOta);
      if (canUseRefreshedPrice) {
        return {
          valid: true,
          refreshed: true,
          totalPrice: refreshedPrice,
          checkedAt: payload.metadata?.price_as_of || new Date().toISOString(),
        };
      }
      const detail = Number.isFinite(refreshedPrice) && refreshedPrice > 0
        ? ` El precio actualizado es ${refreshedPrice.toFixed(2)} EUR.`
        : "";
      return {
        valid: false,
        message:
          `Bluepillow no confirmo el precio final (${payload.reason || "cambio de tarifa"}).` +
          detail,
      };
    })
    .catch((error) => ({
      valid: false,
      message:
        `No se pudo revalidar el total de Bluepillow: ${
          error instanceof Error ? error.message : String(error)
        }`,
    }));
  if (!options.disableCache) sharedValidations.set(key, pending);
  return pending;
}

async function validateTripFinalPrice(offer, search, options = {}) {
  const url = providerRedirectUrl(offer.url);
  let target;
  try {
    target = new URL(url);
  } catch {
    return {
      valid: false,
      message: "Trip.com no proporciono un enlace final valido.",
    };
  }
  if (
    !/(^|\.)trip\.com$/i.test(target.hostname) ||
    !linkMatchesStay(url, search)
  ) {
    return {
      valid: false,
      message: "El enlace final de Trip.com no conserva las fechas exactas.",
    };
  }

  try {
    const fetchImpl = options.providerFetchImpl || fetch;
    const response = await fetchImpl(url, {
      redirect: "follow",
      headers: {
        "accept-language": "es-ES,es;q=0.9,en;q=0.8",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(options.providerTimeoutMs || DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Trip.com respondio ${response.status}.`);
    }
    const html = await response.text();
    const totalPrice = parseTripFinalTotal(html);
    if (!totalPrice) {
      return {
        valid: false,
        message: "Trip.com no mostro un total final comprobable.",
      };
    }
    return {
      valid: true,
      totalPrice,
      url: response.url || url,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      valid: false,
      message:
        `No se pudo comprobar el total directamente en Trip.com: ${
          error instanceof Error ? error.message : String(error)
        }`,
    };
  }
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

async function resolveBluepillowDestination(search, options = {}) {
  const destinationNames = Array.from(
    new Set(
      [
        search.destination.split(",")[0].trim(),
        String(search.locationCity || "").trim(),
      ].filter(Boolean),
    ),
  );
  let lastError = null;
  for (const destinationName of destinationNames) {
    try {
      const resolution = await requestJson("/destinations/resolve", {
        ...options,
        body: {
          name: destinationName,
          ...(search.countryCode ? { country: search.countryCode } : {}),
          language: "es",
        },
      });
      const destination = chooseDestination(resolution.candidates, {
        ...search,
        destination: destinationName,
      });
      if (destination) return destination;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Bluepillow no reconocio el destino ${destinationNames[0] || search.destination}.`,
    { cause: lastError },
  );
}

async function fetchBluepillowSearch(search, options = {}) {
  const coordinateLocation = coordinateSearchLocation(search);
  const destination = coordinateLocation
    ? null
    : await resolveBluepillowDestination(search, options);

  const payload = await requestJson("/search/stays", {
    ...options,
    idempotent: true,
    body: {
      location: {
        ...(coordinateLocation || {
          type: "destination_id",
          value: destination.id,
        }),
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
      filters: bluepillowSearchFilters(search),
      sort: "price_asc",
      page: {
        limit: Math.min(100, Math.max(30, search.maxResults)),
      },
      user_country: "ES",
      language: "es",
      currency: "EUR",
    },
  });
  return {
    destination: destination || {
      id: "",
      name: search.searchArea || search.destination,
      type: search.locationType || "coordinates",
      location: {
        lat: search.originLatitude,
        lon: search.originLongitude,
        default_radius_km: effectiveDistanceLimit(search),
      },
    },
    metadata: payload.metadata || {},
    properties: payload.results || [],
  };
}

function searchCacheKey(search) {
  return JSON.stringify([
    search.destination,
    search.countryCode,
    search.originLatitude,
    search.originLongitude,
    effectiveDistanceLimit(search),
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
  const candidates = offers
    .filter((offer) => offer.matches)
    .sort((left, right) => left.totalPrice - right.totalPrice);
  const matchingOffers = [];
  const verificationErrors = [];
  for (const offer of candidates) {
    const validation = await validateBluepillowOffer(offer, search, options);
    if (!validation.valid) {
      offer.matches = false;
      offer.candidateMatches = false;
      if (!validation.skipped) {
        verificationErrors.push({
          hotelName: offer.hotelName,
          message: validation.message,
        });
      }
      continue;
    }
    if (validation.refreshed) {
      offer.firstObservedPrice = offer.totalPrice;
      offer.priceChangedDuringConfirmation = true;
      offer.totalPrice = validation.totalPrice;
      offer.nightlyPrice =
        Math.round((validation.totalPrice / search.nights) * 100) / 100;
      offer.displayedNightlyPrice = offer.nightlyPrice;
      offer.rateSubtotal = validation.totalPrice;
      offer.searchResultPrice = validation.totalPrice;
      offer.matches = matchesSearch(offer, search);
      offer.candidateMatches = offer.matches;
      if (!offer.matches) continue;
    }
    if (source === "trip") {
      const directValidation = await validateTripFinalPrice(
        offer,
        search,
        options,
      );
      if (!directValidation.valid) {
        offer.matches = false;
        offer.candidateMatches = false;
        verificationErrors.push({
          hotelName: offer.hotelName,
          message: directValidation.message,
        });
        continue;
      }
      offer.totalPrice = directValidation.totalPrice;
      offer.nightlyPrice =
        Math.round((directValidation.totalPrice / search.nights) * 100) / 100;
      offer.provider = "Trip.com";
      offer.url = directValidation.url;
      offer.priceBasis = "trip_direct_final_total_v1";
      offer.taxesText = "Total final leido directamente en Trip.com";
      offer.matches = matchesSearch(offer, search);
      offer.candidateMatches = offer.matches;
      if (!offer.matches) continue;
      validation.checkedAt = directValidation.checkedAt;
    }
    offer.priceVerified = true;
    offer.priceConfirmationCount = 2;
    offer.priceConfirmedAt =
      validation.checkedAt ||
      result.metadata.price_as_of ||
      new Date().toISOString();
    matchingOffers.push(offer);
  }
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
    verificationErrors,
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
  bluepillowSearchFilters,
  buildBluepillowOffer,
  chooseDestination,
  coordinateSearchLocation,
  findSelectedOffer,
  linkMatchesStay,
  mapAmenities,
  mapPropertyType,
  normalizeOta,
  parseBluepillowPriceBreakdown,
  parseTripFinalTotal,
  providerRedirectUrl,
  resolveBluepillowDestination,
  scrapeAgoda,
  scrapeBluepillow,
  scrapeBluepillowSource,
  scrapeTrip,
  stableBluepillowOfferId,
  validateTripFinalPrice,
};
