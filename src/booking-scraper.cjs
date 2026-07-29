const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 60_000;
const BOOKING_PAGE_SIZE = 25;
const MAX_RADIUS_PAGES = 3;

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
    searchArea: String(
      input.searchArea || input.destination?.label || destination,
    ),
    isNearbySearch: input.isNearbySearch === true,
    originLatitude: optionalCoordinate(input.originLatitude, -90, 90),
    originLongitude: optionalCoordinate(input.originLongitude, -180, 180),
    countryCode: String(
      input.countryCode || input.destination?.countryCode || "",
    ).toUpperCase(),
    checkIn,
    checkOut,
    nights,
    adults: clampNumber(input.adults, 1, 20, 2),
    children: clampNumber(input.children, 0, 12, 0),
    rooms: clampNumber(input.rooms, 1, 10, 1),
    maxTotal: clampNumber(input.maxTotal, 0, 100_000, 0),
    maxNightly: clampNumber(input.maxNightly, 0, 10_000, 0),
    priceRule: input.priceRule === "and" ? "and" : "or",
    priceSafetyPercent: clampNumber(
      input.priceSafetyPercent,
      0,
      20,
      0,
    ),
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
    maxVerifiedResults: clampNumber(input.maxVerifiedResults, 1, 20, 10),
  };
}

function optionalCoordinate(value, minimum, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    return null;
  }
  return number;
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

function buildBookingPageUrls(input) {
  const search = normalizeSearch(input);
  const firstUrl = buildBookingSearchUrl(search);
  const pageCount = search.maxDistanceKm > 0
    ? Math.min(
        MAX_RADIUS_PAGES,
        Math.max(1, Math.ceil(search.maxResults / BOOKING_PAGE_SIZE)),
      )
    : 1;
  return Array.from({ length: pageCount }, (_, index) => {
    const url = new URL(firstUrl);
    if (index > 0) {
      url.searchParams.set("offset", String(index * BOOKING_PAGE_SIZE));
    }
    return url.toString();
  });
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

function parseBookingRateTotal(value) {
  try {
    const url = new URL(value);
    const blocks = url.searchParams.get("sr_pri_blocks");
    if (!blocks) return 0;
    const totalInCents = blocks
      .split(",")
      .map((block) => block.match(/__([0-9]+)$/)?.[1] || "")
      .filter(Boolean)
      .reduce((total, price) => total + Number(price), 0);
    return Math.round(totalInCents) / 100;
  } catch {
    return 0;
  }
}

function parseBookingBlockIds(value) {
  try {
    const url = new URL(value);
    const blocks =
      url.searchParams.get("all_sr_blocks") ||
      url.searchParams.get("matching_block_id") ||
      "";
    return blocks
      .split(",")
      .map((block) => block.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseAdditionalCharges(value) {
  const text = String(value || "").trim();
  if (!text || /incluye impuestos|impuestos y cargos incluidos/i.test(text)) {
    return 0;
  }
  if (!/(?:^|\s)\+\s*€|más\s+€|adicional(?:es)?/i.test(text)) return 0;
  return parseEuroPrice(text);
}

function fallbackTaxRateForCountry(countryCode) {
  return String(countryCode || "").toUpperCase() === "ES" ? 0.1 : 0;
}

function calculateVerifiedTableTotal(blockIds, rows, options = {}) {
  const rowsById = new Map(
    rows.map((row) => [String(row.blockId || ""), row]),
  );
  const fallbackTaxRate = clampNumber(
    options.fallbackTaxRate,
    0,
    1,
    0,
  );
  let total = 0;
  for (const blockId of blockIds) {
    const row = rowsById.get(String(blockId));
    if (!row) return 0;
    const price = parseEuroPrice(row.priceText);
    const charges = parseAdditionalCharges(row.taxesText);
    const taxesIncluded =
      /incluye impuestos|impuestos y cargos incluidos/i.test(row.taxesText);
    if (!price || (!taxesIncluded && !charges && !fallbackTaxRate)) return 0;
    total += charges
      ? price + charges
      : price * (1 + (taxesIncluded ? 0 : fallbackTaxRate));
  }
  return Math.round(total * 100) / 100;
}

function stayMatchesSearch(value, search) {
  const text = String(value || "");
  const nightsMatch = text.match(/(\d+)\s+noches?/i);
  const adultsMatch = text.match(/(\d+)\s+adultos?/i);
  return Boolean(
    nightsMatch &&
    adultsMatch &&
    Number(nightsMatch[1]) === search.nights &&
    Number(adultsMatch[1]) === search.adults
  );
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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDistanceKm(value, destination = "") {
  const text = String(value || "").replace(",", ".");
  const kilometerMatch = text.match(/(\d+(?:\.\d+)?)\s*km\s+del centro/i);
  if (kilometerMatch) return Number(kilometerMatch[1]);
  const meterMatch = text.match(/(\d+)\s*m\s+del centro/i);
  if (meterMatch) return Math.round((Number(meterMatch[1]) / 1000) * 100) / 100;

  const destinationName = String(destination || "").split(",")[0].trim();
  if (!destinationName) return 0;
  const destinationPattern = escapeRegExp(destinationName);
  const destinationKilometers = text.match(
    new RegExp(
      `(\\d+(?:\\.\\d+)?)\\s*km\\s+(?:de|del|de la)\\s+${destinationPattern}\\b`,
      "i",
    ),
  );
  if (destinationKilometers) return Number(destinationKilometers[1]);
  const destinationMeters = text.match(
    new RegExp(
      `(\\d+)\\s*m\\s+(?:de|del|de la)\\s+${destinationPattern}\\b`,
      "i",
    ),
  );
  if (destinationMeters) {
    return Math.round((Number(destinationMeters[1]) / 1000) * 100) / 100;
  }
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
    const url = new URL(value);
    url.searchParams.delete("aid");
    url.searchParams.delete("label");
    url.searchParams.delete("sid");
    url.searchParams.set("checkin", search.checkIn);
    url.searchParams.set("checkout", search.checkOut);
    url.searchParams.set("group_adults", String(search.adults));
    url.searchParams.set("req_adults", String(search.adults));
    url.searchParams.set("group_children", String(search.children));
    url.searchParams.set("req_children", String(search.children));
    url.searchParams.set("no_rooms", String(search.rooms));
    url.searchParams.set("selected_currency", "EUR");
    url.searchParams.set("sb_price_type", "total");
    url.searchParams.set("type", "total");
    url.searchParams.set("lang", "es");
    return url.toString();
  } catch {
    return value;
  }
}

function meetsBudget(offer, search) {
  const safetyMultiplier = 1 - search.priceSafetyPercent / 100;
  const totalRule = search.maxTotal > 0
    ? offer.totalPrice <= search.maxTotal * safetyMultiplier
    : null;
  const nightlyRule = search.maxNightly > 0
    ? offer.nightlyPrice <= search.maxNightly * safetyMultiplier
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

function matchesSearch(offer, search, options = {}) {
  if (!meetsBudget(offer, search)) return false;
  if (search.minStars > 0 && offer.stars < search.minStars) return false;
  if (
    search.guestRatingMin > 0 &&
    offer.guestRating < search.guestRatingMin
  ) {
    return false;
  }
  if (search.freeCancellation && !offer.freeCancellation) return false;
  if (search.maxDistanceKm > 0 && !options.ignoreDistance) {
    const distanceIsUnknown =
      offer.distanceKm === null || offer.distanceKm === undefined;
    if (distanceIsUnknown) return false;
    if (
      !distanceIsUnknown &&
      offer.distanceKm > search.maxDistanceKm
    ) {
      return false;
    }
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
        taxesText: read("taxes-and-charges"),
        href: titleLink?.href || "",
        starLabel: labels.find((label) => /^\d(?:[,.]\d)?\s+de\s+5$/i.test(label)) || "",
        text: card.innerText || "",
      };
    }),
    search.maxResults,
  );

  return rawCards.flatMap((card) => {
    const visiblePrice = parseEuroPrice(card.priceText);
    const rateSubtotal = parseBookingRateTotal(card.href);
    const additionalCharges = parseAdditionalCharges(card.taxesText);
    const subtotal = rateSubtotal || visiblePrice;
    const totalPrice = Math.round((subtotal + additionalCharges) * 100) / 100;
    const cardContextValid = Boolean(
      card.title &&
      card.href &&
      rateSubtotal &&
      stayMatchesSearch(card.stayText, search)
    );
    if (!cardContextValid || !totalPrice) return [];
    const nightlyPrice = Math.round((totalPrice / search.nights) * 100) / 100;
    const roomName = card.text.split("\n").find((line) =>
      /habitaci[oó]n|apartamento|estudio|cama/i.test(line),
    ) || "";
    const parsedDistance = parseDistanceKm(
      `${card.address}\n${card.text}`,
      search.destination,
    );
    const destinationName = search.destination.split(",")[0].trim();
    const addressIsInDestination = destinationName
      ? new RegExp(`\\b${escapeRegExp(destinationName)}\\b`, "i")
          .test(card.address)
      : false;
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
      rateSubtotal,
      additionalCharges,
      taxesText: card.taxesText,
      stayText: card.stayText,
      bookingBlockIds: parseBookingBlockIds(card.href),
      priceVerified: false,
      priceBasis: "booking_search_candidate",
      stars: parseStars(card.starLabel),
      guestRating: parseReviewScore(card.reviewText),
      reviewCount: parseReviewCount(card.reviewText),
      distanceKm:
        parsedDistance > 0 || addressIsInDestination ? parsedDistance : null,
      freeCancellation: /cancelaci[oó]n gratis/i.test(card.text),
      breakfastIncluded: /desayuno incluido/i.test(card.text),
      limitedAvailability: /nos quedan \d+/i.test(card.text),
      propertyType: detectPropertyType(`${card.title}\n${card.text}`),
      amenities: detectAmenities(card.text),
      mealPlan: detectMealPlan(card.text),
      roomName,
      sharedRoom: isSharedRoomText(`${roomName}\n${card.text}`),
      searchArea: search.searchArea,
      url: sanitizeBookingUrl(card.href, search),
    };
    offer.candidateMatches = matchesSearch(offer, search, {
      ignoreDistance: true,
    });
    offer.matches = false;
    return [offer];
  });
}

async function verifyBookingOffer(page, offer, search, options = {}) {
  if (!offer.bookingBlockIds?.length) {
    throw new Error("Booking no indicó la habitación exacta de la tarifa.");
  }

  await page.goto(offer.url, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs || 25_000,
  });
  await page.locator("#hprt-table tr[data-block-id]").first().waitFor({
    state: "visible",
    timeout: options.timeoutMs || 25_000,
  });

  const currentUrl = new URL(page.url());
  if (
    currentUrl.searchParams.get("checkin") !== search.checkIn ||
    currentUrl.searchParams.get("checkout") !== search.checkOut ||
    Number(currentUrl.searchParams.get("group_adults")) !== search.adults ||
    Number(currentUrl.searchParams.get("group_children") || 0) !==
      search.children ||
    Number(currentUrl.searchParams.get("no_rooms")) !== search.rooms
  ) {
    throw new Error("Booking cambió las fechas, viajeros o habitaciones.");
  }

  if (
    search.maxDistanceKm > 0 &&
    search.originLatitude !== null &&
    search.originLongitude !== null
  ) {
    const coordinatesText = await page
      .locator("[data-atlas-latlng]")
      .first()
      .getAttribute("data-atlas-latlng")
      .catch(() => "");
    const [hotelLatitude, hotelLongitude] = String(coordinatesText || "")
      .split(",")
      .map(Number);
    if (
      Number.isFinite(hotelLatitude) &&
      Number.isFinite(hotelLongitude)
    ) {
      offer.latitude = hotelLatitude;
      offer.longitude = hotelLongitude;
      offer.distanceKm = Math.round(
        distanceBetweenCoordinates(
          search.originLatitude,
          search.originLongitude,
          hotelLatitude,
          hotelLongitude,
        ) * 100,
      ) / 100;
      offer.distanceVerified = true;
    } else {
      offer.distanceKm = null;
      offer.distanceVerified = false;
    }
  }

  const rows = await page.locator("#hprt-table").evaluate(
    (table, blockIds) => {
      return Array.from(table.querySelectorAll("tr[data-block-id]"))
        .filter((row) => blockIds.includes(row.getAttribute("data-block-id")))
        .map((row) => {
          const priceCell = row.querySelector(".hprt-table-cell-price");
          const priceText =
            row.querySelector(
              ".prco-valign-middle-helper, [data-testid='price-and-discounted-price']",
            )?.textContent?.trim() ||
            priceCell?.innerText?.trim() ||
            "";
          const visibleTaxText = (priceCell?.innerText || row.innerText || "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => /impuestos|cargos/i.test(line))
            .join(" ");
          return {
            blockId: row.getAttribute("data-block-id") || "",
            priceText,
            taxesText:
            row.querySelector(".prd-taxes-and-fees-under-price")
              ?.textContent?.trim() ||
              visibleTaxText,
          };
        });
    },
    offer.bookingBlockIds,
  );

  const verifiedTotal = calculateVerifiedTableTotal(
    offer.bookingBlockIds,
    rows,
    {
      fallbackTaxRate: fallbackTaxRateForCountry(search.countryCode),
    },
  );
  if (!verifiedTotal) {
    throw new Error(
      "Booking no mostró un total final con impuestos para esa habitación.",
    );
  }

  offer.searchResultPrice = offer.totalPrice;
  offer.totalPrice = verifiedTotal;
  offer.nightlyPrice =
    Math.round((verifiedTotal / search.nights) * 100) / 100;
  offer.bookingTableTotal = verifiedTotal;
  offer.verificationRows = rows;
  offer.taxFallbackRate = rows.some((row) => !row.taxesText)
    ? fallbackTaxRateForCountry(search.countryCode)
    : 0;
  offer.priceVerified = true;
  offer.priceBasis = offer.taxFallbackRate
    ? "booking_availability_table_with_country_tax"
    : "booking_availability_table";
  offer.matches = matchesSearch(offer, search);
  return offer;
}

function distanceBetweenCoordinates(
  latitudeA,
  longitudeA,
  latitudeB,
  longitudeB,
) {
  const toRadians = (value) => Number(value) * Math.PI / 180;
  const earthRadiusKm = 6371.0088;
  const latA = toRadians(latitudeA);
  const latB = toRadians(latitudeB);
  const latitudeDelta = toRadians(Number(latitudeB) - Number(latitudeA));
  const longitudeDelta = toRadians(Number(longitudeB) - Number(longitudeA));
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latA) *
      Math.cos(latB) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(haversine));
}

async function verifyBookingCandidates(context, offers, search, options = {}) {
  const candidates = offers
    .filter((offer) => offer.candidateMatches)
    .sort((left, right) => left.totalPrice - right.totalPrice)
    .slice(0, search.maxVerifiedResults);
  const errors = [];
  if (!candidates.length) return errors;

  const page = await context.newPage();
  try {
    for (const offer of candidates) {
      try {
        await verifyBookingOffer(page, offer, search, {
          timeoutMs: Math.min(options.timeoutMs || 25_000, 25_000),
        });
      } catch (error) {
        offer.matches = false;
        offer.priceVerified = false;
        offer.verificationError =
          error instanceof Error ? error.message : String(error);
        errors.push({
          hotelName: offer.hotelName,
          message: offer.verificationError,
        });
      }
    }
  } finally {
    await page.close();
  }
  return errors;
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
    const pageUrls = buildBookingPageUrls(search);
    const offers = [];
    const seenOfferIds = new Set();
    let searchedPages = 0;
    for (const [pageIndex, pageUrl] of pageUrls.entries()) {
      try {
        await page.goto(pageUrl, {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        });
        await page.locator('[data-testid="property-card"]').first().waitFor({
          state: "visible",
          timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        });
      } catch (error) {
        if (pageIndex > 0) break;
        const challenged = /[?&]chal_t=|force_referer/i.test(page.url());
        throw new Error(
          challenged
            ? "Booking ha solicitado una comprobación del navegador; no se publican precios."
            : "Booking no ha mostrado resultados de alojamiento dentro del tiempo límite.",
          { cause: error },
        );
      }
      searchedPages += 1;

      const pageOffers = await extractVisibleCards(page, search);
      for (const offer of pageOffers) {
        if (seenOfferIds.has(offer.id)) continue;
        seenOfferIds.add(offer.id);
        offers.push(offer);
      }
    }

    const verificationErrors = await verifyBookingCandidates(
      context,
      offers,
      search,
      options,
    );
    const matchingOffers = offers
      .filter((offer) => offer.matches)
      .sort((left, right) => left.totalPrice - right.totalPrice);
    return {
      source: "booking",
      searchedAt: new Date().toISOString(),
      search,
      searchUrl: pageUrls[0],
      searchedPages,
      offers,
      matchingOffers,
      verificationErrors,
      cheapestOffer: offers
        .filter((offer) => offer.priceVerified)
        .slice()
        .sort((left, right) => left.totalPrice - right.totalPrice)[0] || null,
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
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
  parseEuroPrice,
  parseDistanceKm,
  parseLocalizedNumber,
  parseReviewCount,
  parseReviewScore,
  parseStars,
  scrapeBooking,
  stayMatchesSearch,
  verifyBookingOffer,
};
