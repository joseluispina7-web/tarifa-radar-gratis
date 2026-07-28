const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 60_000;

function assertIsoDate(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    throw new Error(`${fieldName} debe tener formato AAAA-MM-DD.`);
  }
}

function nightsBetween(checkIn, checkOut) {
  assertIsoDate(checkIn, "checkIn");
  assertIsoDate(checkOut, "checkOut");
  const start = new Date(`${checkIn}T12:00:00Z`);
  const end = new Date(`${checkOut}T12:00:00Z`);
  const nights = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (nights < 1) throw new Error("checkOut debe ser posterior a checkIn.");
  return nights;
}

function normalizeSearch(input = {}) {
  const destination = String(
    input.destination?.query || input.destination?.name || input.destination || "",
  ).trim();
  if (!destination) throw new Error("Falta el destino.");

  const checkIn = String(input.checkIn || input.dateStart || "");
  const checkOut = String(input.checkOut || input.dateEnd || "");
  const nights = nightsBetween(checkIn, checkOut);

  return {
    id: String(input.id || "manual-search"),
    name: String(input.name || `${destination} · ${nights} noches`),
    destination,
    destinationLabel: String(
      input.destination?.label || input.destinationLabel || destination,
    ),
    checkIn,
    checkOut,
    nights,
    adults: clampNumber(input.adults, 1, 20, 2),
    children: clampNumber(input.children, 0, 12, 0),
    rooms: clampNumber(input.rooms, 1, 10, 1),
    maxTotal: clampNumber(input.maxTotal, 0, 100_000, 0),
    maxNightly: clampNumber(input.maxNightly, 0, 10_000, 0),
    priceRule: input.priceRule === "and" ? "and" : "or",
    minStars: clampNumber(input.minStars, 0, 5, 0),
    guestRatingMin: clampNumber(input.guestRatingMin, 0, 10, 0),
    maxDistanceKm: clampNumber(input.maxDistanceKm, 0, 100, 0),
    freeCancellation: input.freeCancellation === true,
    mealPlan: ["breakfast", "half_board", "all_inclusive"].includes(
      input.mealPlan,
    )
      ? input.mealPlan
      : "any",
    propertyTypes: Array.isArray(input.propertyTypes)
      ? input.propertyTypes.map(String)
      : [],
    amenities: Array.isArray(input.amenities)
      ? input.amenities.map(String)
      : [],
    excludeSharedRooms: input.excludeSharedRooms !== false,
    maxResults: clampNumber(input.maxResults, 1, 100, 30),
  };
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function buildBookingSearchUrl(input) {
  const search = normalizeSearch(input);
  const url = new URL("https://www.booking.com/searchresults.es.html");
  url.searchParams.set("ss", search.destination);
  url.searchParams.set("checkin", search.checkIn);
  url.searchParams.set("checkout", search.checkOut);
  url.searchParams.set("group_adults", String(search.adults));
  url.searchParams.set("group_children", String(search.children));
  url.searchParams.set("no_rooms", String(search.rooms));
  url.searchParams.set("selected_currency", "EUR");
  url.searchParams.set("order", "price");

  const filters = [];
  if (search.minStars > 0) {
    for (let stars = search.minStars; stars <= 5; stars += 1) {
      filters.push(`class=${stars}`);
    }
  }
  if (search.guestRatingMin >= 6) {
    filters.push(`review_score=${Math.floor(search.guestRatingMin) * 10}`);
  }
  if (search.freeCancellation) filters.push("fc=2");
  if (filters.length) url.searchParams.set("nflt", filters.join(";"));

  return url.toString();
}

function parseLocalizedNumber(value) {
  const normalized = String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[^\d.,-]/g, "")
    .trim();
  if (!normalized) return 0;

  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");
  let numberText = normalized;
  if (hasComma && hasDot) {
    numberText = normalized.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    numberText = normalized.replace(",", ".");
  } else if (hasDot && /^\d{1,3}(?:\.\d{3})+$/.test(normalized)) {
    numberText = normalized.replace(/\./g, "");
  }
  const parsed = Number(numberText);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseEuroPrice(value) {
  const matches = Array.from(
    String(value || "").matchAll(/€\s*([\d.]+(?:,\d{1,2})?)/g),
  );
  if (!matches.length) return 0;
  return parseLocalizedNumber(matches[matches.length - 1][1]);
}

function parseReviewScore(value) {
  const match = String(value || "").match(/Puntuaci[oó]n:\s*(\d{1,2}(?:[,.]\d)?)/i);
  return match ? parseLocalizedNumber(match[1]) : 0;
}

function parseReviewCount(value) {
  const match = String(value || "").match(/([\d.]+)\s+comentarios?/i);
  return match ? Math.round(parseLocalizedNumber(match[1])) : 0;
}

function parseStars(value) {
  const match = String(value || "").match(/^(\d(?:[,.]\d)?)\s+de\s+5$/i);
  return match ? parseLocalizedNumber(match[1]) : 0;
}

function parseDistanceKm(value) {
  const text = String(value || "").replace(",", ".");
  const kilometerMatch = text.match(/(\d+(?:\.\d+)?)\s*km\s+del centro/i);
  if (kilometerMatch) return Number(kilometerMatch[1]);
  const meterMatch = text.match(/(\d+)\s*m\s+del centro/i);
  if (meterMatch) return Math.round((Number(meterMatch[1]) / 1000) * 100) / 100;
  return 0;
}

function detectPropertyType(value) {
  const text = String(value || "");
  if (/apartamento|aparthotel|apartahotel/i.test(text)) return "apartment";
  if (/resort/i.test(text)) return "resort";
  if (/casa rural|agroturismo/i.test(text)) return "rural";
  if (/hostal|hostel|albergue|pensi[oó]n|guest house/i.test(text)) return "hostel";
  return "hotel";
}

function detectAmenities(value) {
  const text = String(value || "");
  const matches = [
    ["pool", /piscina/i],
    ["spa", /\bspa\b|baño turco|sauna/i],
    ["parking", /parking|aparcamiento/i],
    ["beach", /playa|frente al mar/i],
    ["breakfast", /desayuno incluido/i],
    ["pets", /admite mascotas|mascotas permitidas/i],
    ["air_conditioning", /aire acondicionado/i],
    ["family_rooms", /habitaciones familiares/i],
    ["all_inclusive", /todo incluido/i],
    ["gym", /gimnasio|centro de fitness/i],
  ];
  return matches
    .filter(([, pattern]) => pattern.test(text))
    .map(([amenity]) => amenity);
}

function detectMealPlan(value) {
  const text = String(value || "");
  if (/todo incluido/i.test(text)) return "all_inclusive";
  if (/media pensi[oó]n/i.test(text)) return "half_board";
  if (/desayuno incluido/i.test(text)) return "breakfast";
  return "any";
}

function sanitizeBookingUrl(value, search) {
  try {
    const original = new URL(value);
    const clean = new URL(`${original.origin}${original.pathname}`);
    clean.searchParams.set("checkin", search.checkIn);
    clean.searchParams.set("checkout", search.checkOut);
    clean.searchParams.set("group_adults", String(search.adults));
    clean.searchParams.set("group_children", String(search.children));
    clean.searchParams.set("no_rooms", String(search.rooms));
    return clean.toString();
  } catch {
    return value;
  }
}

function meetsBudget(offer, search) {
  const totalRule = search.maxTotal > 0
    ? offer.totalPrice <= search.maxTotal
    : null;
  const nightlyRule = search.maxNightly > 0
    ? offer.nightlyPrice <= search.maxNightly
    : null;
  const priceRules = [totalRule, nightlyRule].filter((value) => value !== null);
  if (!priceRules.length) return true;
  return search.priceRule === "and"
    ? priceRules.every(Boolean)
    : priceRules.some(Boolean);
}

function isSharedRoomText(value) {
  return /habitaci[oó]n compartida|dormitorio compartido|cama (?:individual |doble )?en (?:una )?(?:habitaci[oó]n|dormitorio)|litera en|cama en cápsula/i
    .test(String(value || ""));
}

function matchesSearch(offer, search) {
  if (!meetsBudget(offer, search)) return false;
  if (search.minStars > 0 && offer.stars < search.minStars) return false;
  if (
    search.guestRatingMin > 0 &&
    offer.guestRating < search.guestRatingMin
  ) {
    return false;
  }
  if (search.freeCancellation && !offer.freeCancellation) return false;
  if (
    search.maxDistanceKm > 0 &&
    (!offer.distanceKm || offer.distanceKm > search.maxDistanceKm)
  ) {
    return false;
  }
  if (
    search.mealPlan !== "any" &&
    offer.mealPlan !== search.mealPlan &&
    !(
      search.mealPlan === "breakfast" &&
      offer.amenities?.includes("breakfast")
    )
  ) {
    return false;
  }
  if (
    search.propertyTypes.length > 0 &&
    !search.propertyTypes.includes(offer.propertyType)
  ) {
    return false;
  }
  if (
    search.amenities.length > 0 &&
    !search.amenities.every((amenity) => offer.amenities?.includes(amenity))
  ) {
    return false;
  }
  if (search.excludeSharedRooms && offer.sharedRoom) return false;
  return true;
}

function resolveChromeExecutable() {
  if (process.env.CHROME_EXECUTABLE) return process.env.CHROME_EXECUTABLE;
  if (process.platform !== "win32") return undefined;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function extractVisibleCards(page, search) {
  const rawCards = await page.locator('[data-testid="property-card"]').evaluateAll(
    (cards, limit) => cards.slice(0, limit).map((card) => {
      const read = (testId) =>
        card.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() || "";
      const labels = Array.from(card.querySelectorAll("[aria-label]"))
        .map((element) => element.getAttribute("aria-label") || "");
      const titleLink = card.querySelector('[data-testid="title-link"]');
      return {
        title: read("title"),
        address: read("address-link"),
        reviewText: read("review-score"),
        priceText: read("price-and-discounted-price"),
        stayText: read("price-for-x-nights"),
        href: titleLink?.href || "",
        starLabel: labels.find((label) => /^\d(?:[,.]\d)?\s+de\s+5$/i.test(label)) || "",
        text: card.innerText || "",
      };
    }),
    search.maxResults,
  );

  return rawCards.flatMap((card) => {
    const totalPrice = parseEuroPrice(card.priceText);
    if (!card.title || !totalPrice) return [];
    const nightlyPrice = Math.round((totalPrice / search.nights) * 100) / 100;
    const roomName = card.text.split("\n").find((line) =>
      /habitaci[oó]n|apartamento|estudio|cama/i.test(line),
    ) || "";
    const offer = {
      id: `${new URL(card.href).pathname}|${search.checkIn}|${search.checkOut}`,
      source: "booking",
      hotelName: card.title,
      address: card.address,
      checkIn: search.checkIn,
      checkOut: search.checkOut,
      nights: search.nights,
      totalPrice,
      nightlyPrice,
      stars: parseStars(card.starLabel),
      guestRating: parseReviewScore(card.reviewText),
      reviewCount: parseReviewCount(card.reviewText),
      distanceKm: parseDistanceKm(`${card.address}\n${card.text}`),
      freeCancellation: /cancelaci[oó]n gratis/i.test(card.text),
      breakfastIncluded: /desayuno incluido/i.test(card.text),
      limitedAvailability: /nos quedan \d+/i.test(card.text),
      propertyType: detectPropertyType(`${card.title}\n${card.text}`),
      amenities: detectAmenities(card.text),
      mealPlan: detectMealPlan(card.text),
      roomName,
      sharedRoom: isSharedRoomText(`${roomName}\n${card.text}`),
      url: sanitizeBookingUrl(card.href, search),
    };
    offer.matches = matchesSearch(offer, search);
    return [offer];
  });
}

async function scrapeBooking(input, options = {}) {
  const search = normalizeSearch(input);
  const { chromium } = require("playwright");
  const executablePath = options.executablePath || resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: options.headless !== false,
    executablePath,
  });

  try {
    const context = await browser.newContext({
      locale: "es-ES",
      timezoneId: "Europe/Madrid",
      viewport: { width: 1365, height: 900 },
    });
    const page = await context.newPage();
    const url = buildBookingSearchUrl(search);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    try {
      await page.locator('[data-testid="property-card"]').first().waitFor({
        state: "visible",
        timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      const challenged = /[?&]chal_t=|force_referer/i.test(page.url());
      throw new Error(
        challenged
          ? "Booking ha solicitado una comprobación del navegador; no se publican precios."
          : "Booking no ha mostrado resultados de alojamiento dentro del tiempo límite.",
        { cause: error },
      );
    }

    const offers = await extractVisibleCards(page, search);
    const matchingOffers = offers
      .filter((offer) => offer.matches)
      .sort((left, right) => left.totalPrice - right.totalPrice);
    return {
      source: "booking",
      searchedAt: new Date().toISOString(),
      search,
      searchUrl: url,
      offers,
      matchingOffers,
      cheapestOffer: offers
        .slice()
        .sort((left, right) => left.totalPrice - right.totalPrice)[0] || null,
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  buildBookingSearchUrl,
  detectAmenities,
  detectMealPlan,
  detectPropertyType,
  isSharedRoomText,
  matchesSearch,
  nightsBetween,
  normalizeSearch,
  parseEuroPrice,
  parseDistanceKm,
  parseLocalizedNumber,
  parseReviewCount,
  parseReviewScore,
  parseStars,
  scrapeBooking,
};
