const crypto = require("node:crypto");
const fs = require("node:fs");
const {
  detectAmenities,
  detectMealPlan,
  detectPropertyType,
  distanceBetweenCoordinates,
  effectiveDistanceLimit,
  isSharedRoomText,
  matchesSearch,
  normalizeSearch,
  parseDistanceKm,
  parseLocalizedNumber,
} = require("./booking-scraper.cjs");

const DEFAULT_TIMEOUT_MS = 30_000;
const GOOGLE_SOURCE = "google_hotels";
const MAX_GOOGLE_LOCATION_CANDIDATES = 8;
const PHOTON_SEARCH_URL = "https://photon.komoot.io/api/";
const POSITIVE_LOCATION_CACHE_MS = 180 * 86_400_000;
const NEGATIVE_LOCATION_CACHE_MS = 30 * 86_400_000;
const GOOGLE_HOTELS_SEED_URL =
  "https://www.google.com/travel/search?" +
  "q=hoteles%20en%20Madrid&" +
  "ts=CAEaNAoWEhIKCC9tLzA1Nl95OgZNYWRyaWQaABIaEhQKBwjqDxAIGAUSBwjqDxAIGAkYBDICCAEqCQoFOgNFVVIaAA&" +
  "qs=CAE4DQ&ap=MAE";

function buildGoogleHotelsSearchUrl(input) {
  const search = normalizeSearch(input);
  const url = new URL("https://www.google.com/travel/search");
  url.searchParams.set("q", `hoteles en ${search.destination}`);
  url.searchParams.set("hl", "es");
  url.searchParams.set("gl", "es");
  url.searchParams.set("curr", "EUR");
  return url.toString();
}

function googleHotelsLoadAttempt(searchUrl, attempt) {
  return attempt === 0
    ? { url: GOOGLE_HOTELS_SEED_URL, selectDestination: true }
    : { url: searchUrl, selectDestination: false };
}

function parseGoogleHotelsTotal(value) {
  const text = String(value || "");
  const suffixMatch = text.match(
    /([\d][\d.\s\u00a0]*(?:,\d{1,2})?)\s*\u20ac\s+(?:en total|total)/i,
  );
  const prefixMatch = text.match(
    /\u20ac\s*([\d][\d.,\s\u00a0]*)\s+(?:en total|total)/i,
  );
  const match = suffixMatch || prefixMatch;
  return match ? parseLocalizedNumber(match[1]) : 0;
}

function parseGoogleHotelsNightly(value) {
  const text = String(value || "");
  const suffixMatch = text.match(
    /^\s*([\d][\d.\s\u00a0]*(?:,\d{1,2})?)\s*\u20ac/i,
  );
  const prefixMatch = text.match(
    /^\s*\u20ac\s*([\d][\d.,\s\u00a0]*?)(?=\s*\u20ac|\s|$)/i,
  );
  const match = suffixMatch || prefixMatch;
  return match ? parseLocalizedNumber(match[1]) : 0;
}

function parseGoogleCandidateNightly(value) {
  const text = String(value || "");
  const suffixMatch = text.match(
    /([\d][\d.\s\u00a0]*(?:,\d{1,2})?)\s*(?:\u20ac|EUR)/i,
  );
  const prefixMatch = text.match(
    /(?:\u20ac|EUR)\s*([\d][\d.,\s\u00a0]*)/i,
  );
  const match = suffixMatch || prefixMatch;
  return match ? parseLocalizedNumber(match[1]) : 0;
}

function repeatedlyDecodeUrl(value) {
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

function parseGoogleProviderInclusiveTotal(value) {
  const candidates = repeatedlyDecodeUrl(value);
  for (const candidate of candidates) {
    const currencyMatches = Array.from(
      candidate.matchAll(
        /(?:currency|display_currency|selected_currency|partnercurrency|currency_code|currencycode|mpd|curr|divisa)=([A-Z]{3})/gi,
      ),
    );
    const hasEurCurrency = currencyMatches.some(
      (match) => match[1].toUpperCase() === "EUR",
    ) || /\u20ac/.test(candidate);
    if (!hasEurCurrency) continue;

    const bluepillowTotal =
      /bluepillow\.(?:com|es)\//i.test(candidate) &&
      /(?:^|[?&])(?:begin|checkin)=\d{4}-\d{2}-\d{2}/i.test(candidate) &&
      /(?:^|[?&])(?:tax|fees)=[\d.,]+/i.test(candidate)
        ? candidate.match(/(?:^|[?&])total=([\d.,]+)/i)
        : null;
    if (bluepillowTotal) return parseLocalizedNumber(bluepillowTotal[1]);

    const superTotal =
      /(?:^|\/\/)(?:www\.)?super\.com\//i.test(candidate) &&
      /(?:^|[?&])checkin_at=\d{4}-\d{2}-\d{2}/i.test(candidate) &&
      /(?:^|[?&])checkout_at=\d{4}-\d{2}-\d{2}/i.test(candidate)
        ? candidate.match(
            /(?:^|[?&])(?:display_all_inclusive_price|all_inclusive_price|total_including_taxes|total_with_taxes)=([\d.,]+)/i,
          )
        : null;
    if (superTotal) return parseLocalizedNumber(superTotal[1]);

    const bookingTotal =
      /(?:^|\/\/)(?:www\.)?booking\.com\//i.test(candidate) &&
      /(?:^|[?&])ext_price_tax=[\d.,]+/i.test(candidate)
        ? candidate.match(/(?:^|[?&])ext_price_total=([\d.,]+)/i)
        : null;
    if (bookingTotal) return parseLocalizedNumber(bookingTotal[1]);

    const agodaTotal =
      /(?:^|\/\/)(?:www\.)?agoda\.com\//i.test(candidate) &&
      /(?:^|[?&])PriceTax=[\d.,]+/i.test(candidate)
        ? candidate.match(/(?:^|[?&])PriceTotal=([\d.,]+)/i)
        : null;
    if (agodaTotal) return parseLocalizedNumber(agodaTotal[1]);

    const trivagoTotal =
      /(?:^|\/\/)(?:www\.)?trivago\.deals\//i.test(candidate) &&
      /(?:^|[?&])priceDisplayedTax=[\d.,]+/i.test(candidate)
        ? candidate.match(/(?:^|[?&])priceDisplayedTotal=([\d.,]+)/i)
        : null;
    if (trivagoTotal) return parseLocalizedNumber(trivagoTotal[1]);

    if (/(?:^|\/\/)(?:www\.)?(?:expedia|hotels)\.com\//i.test(candidate)) {
      const subtotal = candidate.match(/(?:^|[?&])mpa=([\d.,]+)/i);
      const taxes = candidate.match(/(?:^|[?&])mpb=([\d.,]+)/i);
      if (subtotal && taxes) {
        return Math.round(
          (parseLocalizedNumber(subtotal[1]) +
            parseLocalizedNumber(taxes[1])) * 100,
        ) / 100;
      }
    }
  }
  return 0;
}

function parseGoogleProviderVisibleTotal(value) {
  const text = String(value || "");
  if (!/Visitar sitio web|Visit website/i.test(text)) return 0;
  if (/(?:US\$|USD|\$)\s*\d/i.test(text)) return 0;
  if (
    !/(?:precio\s+)?total\s+(?:de\s+)?(?:la\s+)?estancia|total\s+(?:for|of)\s+(?:the\s+)?stay|stay\s+total/i.test(
      text,
    )
  ) {
    return 0;
  }

  const prices = Array.from(
    text.matchAll(
      /(?:EUR\s*([\d][\d.,\s\u00a0]*)|([\d][\d.,\s\u00a0]*)\s*(?:\u20ac|EUR))/gi,
    ),
    (match) => {
      const compact = String(match[1] || match[2])
        .replace(/[\s\u00a0]/g, "");
      if (/^\d{1,3}(?:,\d{3})+$/.test(compact)) {
        return Number(compact.replaceAll(",", ""));
      }
      if (/^\d{1,3}(?:\.\d{3})+$/.test(compact)) {
        return Number(compact.replaceAll(".", ""));
      }
      return parseLocalizedNumber(compact);
    },
  ).filter((price) => Number.isFinite(price) && price > 0);
  return prices.at(-1) || 0;
}

function parseGoogleHotelsNights(value) {
  const match = String(value || "").match(/(\d+)\s+(?:noches?|nights?)/i);
  return match ? Number(match[1]) : 0;
}

function googleTotalMatchesNightly(totalPrice, nightlyPrice, nights) {
  const total = Number(totalPrice);
  const nightly = Number(nightlyPrice);
  const stayNights = Number(nights);
  if (!(total > 0) || !(nightly > 0) || !(stayNights > 0)) return false;
  const expectedSubtotal = nightly * stayNights;
  return (
    total >= expectedSubtotal * 0.8 &&
    total <= expectedSubtotal * 2.5
  );
}

function parseGoogleGuestRating(value) {
  const match = String(value || "").match(
    /(\d(?:[,.]\d)?)\s+(?:de\s+5\s+estrellas?|out of 5 stars?)/i,
  );
  return match
    ? Math.round(parseLocalizedNumber(match[1]) * 2 * 10) / 10
    : 0;
}

function parseGoogleStars(value) {
  const match = String(value || "").match(
    /(?:hotel de\s+(\d(?:[,.]\d)?)\s+estrellas?|(\d(?:[,.]\d)?)-star hotel)/i,
  );
  return match ? parseLocalizedNumber(match[1] || match[2]) : 0;
}

function parseGoogleReviewCount(value) {
  const text = String(value || "");
  const match = text.match(
    /(?:de|from)\s+([\d.\s\u00a0]+)\s+(?:rese\u00f1as?|reviews?)/i,
  );
  if (!match) return 0;
  const numberText =
    /reviews?/i.test(text) && /^\d{1,3}(?:,\d{3})+$/.test(match[1].trim())
      ? match[1].replaceAll(",", "")
      : match[1];
  return Math.round(parseLocalizedNumber(numberText));
}

function detectGoogleAmenities(value) {
  const text = String(value || "");
  const amenities = new Set(detectAmenities(text));
  const patterns = [
    ["pool", /\bpool\b/i],
    ["spa", /\bspa\b|\bsauna\b/i],
    ["parking", /\bparking\b/i],
    ["beach", /\bbeach\b|oceanfront/i],
    ["breakfast", /breakfast included/i],
    ["pets", /pet-friendly|pets allowed/i],
    ["air_conditioning", /air conditioning/i],
    ["family_rooms", /family rooms/i],
    ["all_inclusive", /all-inclusive/i],
    ["gym", /\bgym\b|fitness cent(?:er|re)/i],
  ];
  for (const [amenity, pattern] of patterns) {
    if (pattern.test(text)) amenities.add(amenity);
  }
  return Array.from(amenities);
}

function stableOfferId(hotelName, checkIn, checkOut) {
  const hotelId = crypto
    .createHash("sha1")
    .update(String(hotelName || "").trim().toLocaleLowerCase("es"))
    .digest("hex")
    .slice(0, 16);
  return `${GOOGLE_SOURCE}:${hotelId}|${checkIn}|${checkOut}`;
}

function buildGoogleOffer(card, search) {
  const totalPrice = parseGoogleHotelsTotal(card.priceText);
  const displayedNights = parseGoogleHotelsNights(card.priceText);
  const displayedNightlyPrice = parseGoogleHotelsNightly(card.priceText);
  const includesTaxes =
    /impuestos y tasas incluidos|taxes and fees included|including taxes and fees/i.test(
      String(card.priceText || ""),
    );
  if (
    !card.hotelName ||
    !card.url ||
    !totalPrice ||
    !displayedNightlyPrice ||
    displayedNights !== search.nights ||
    !googleTotalMatchesNightly(
      totalPrice,
      displayedNightlyPrice,
      search.nights,
    ) ||
    !includesTaxes
  ) {
    return null;
  }

  const text = `${card.text || ""}\n${(card.labels || []).join("\n")}`;
  const nightlyPrice =
    Math.round((totalPrice / search.nights) * 100) / 100;
  const parsedDistance = parseDistanceKm(text, search.destination);
  const offer = {
    id: stableOfferId(card.hotelName, search.checkIn, search.checkOut),
    source: GOOGLE_SOURCE,
    provider: "Google Hotels",
    hotelName: card.hotelName,
    address: search.searchArea,
    checkIn: search.checkIn,
    checkOut: search.checkOut,
    nights: search.nights,
    totalPrice,
    nightlyPrice,
    displayedNightlyPrice,
    rateSubtotal: totalPrice,
    searchResultPrice: totalPrice,
    additionalCharges: 0,
    taxesText: "Impuestos y tasas incluidos segun Google Hotels",
    stayText: `${search.nights} noches con impuestos y tasas incluidos`,
    priceVerified: true,
    priceBasis: "google_hotels_visible_all_inclusive_v7",
    priceConfirmationCount: 2,
    priceConfirmedAt: new Date().toISOString(),
    stars: parseGoogleStars(text),
    guestRating: parseGoogleGuestRating(text),
    reviewCount: parseGoogleReviewCount(text),
    distanceKm: parsedDistance > 0 ? parsedDistance : null,
    // Google can express this relative to a nearby town rather than to the
    // exact point selected in the radar, so it is not valid for a hard radius.
    distanceVerified: false,
    freeCancellation:
      /cancelaci\u00f3n gratis|free cancellation/i.test(text),
    breakfastIncluded: /desayuno incluido|breakfast included/i.test(text),
    limitedAvailability: false,
    propertyType: detectPropertyType(`${card.hotelName}\n${text}`),
    amenities: detectGoogleAmenities(text),
    mealPlan: detectMealPlan(text),
    roomName: "",
    sharedRoom:
      isSharedRoomText(`${card.hotelName}\n${text}`) ||
      /shared (?:room|bathroom)|ba\u00f1o compartido/i.test(
        `${card.hotelName}\n${text}`,
      ),
    searchArea: search.searchArea,
    url: card.url,
  };
  offer.matches = matchesSearch(offer, search);
  offer.candidateMatches = offer.matches;
  return offer;
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

async function acceptGoogleConsent(page) {
  if (!/consent\.google\./i.test(page.url())) return;
  const acceptButton = page
    .getByRole("button", { name: /Aceptar todo|Accept all/i })
    .first();
  if (await acceptButton.count()) {
    await acceptButton.click();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  }
}

async function selectGoogleHotelsCurrency(page, timeoutMs) {
  const currencyButton = page
    .getByRole("button", { name: /Moneda|Currency/i })
    .first();
  await currencyButton.waitFor({ state: "visible", timeout: timeoutMs });
  if (/\bEUR\b/i.test(await currencyButton.innerText())) return;

  await currencyButton.click();
  const dialog = page
    .locator('[role="dialog"]:visible')
    .filter({ has: page.locator('[role="radio"][data-value="EUR"]') })
    .last();
  await dialog.waitFor({ state: "visible", timeout: timeoutMs });
  const euro = dialog.locator('[role="radio"][data-value="EUR"]').first();
  await euro.click({ force: true }).catch(async () => {
    await euro.evaluate((element) => element.click());
  });
  await dialog
    .getByRole("button", { name: /Hecho|Done|Listo|Aplicar|Apply/i })
    .last()
    .click();
  await dialog.waitFor({ state: "hidden", timeout: timeoutMs }).catch(() => {});
  await page.waitForTimeout(500);

  const selectedCurrency = await page
    .getByRole("button", { name: /Moneda|Currency/i })
    .first()
    .innerText()
    .catch(() => "");
  if (!/\bEUR\b/i.test(selectedCurrency)) {
    throw new Error("Google Hotels no mantuvo la moneda EUR.");
  }
}

function normalizeGoogleQuery(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function googleDestinationScopeMatches(title, search) {
  const normalizedTitle = normalizeGoogleQuery(title);
  const requestedPlace = normalizeGoogleQuery(
    String(search.destination || "").split(",")[0],
  );
  const parentCity = normalizeGoogleQuery(search.locationCity);
  if (requestedPlace && normalizedTitle.includes(requestedPlace)) return true;
  return Boolean(
    !search.isNearbySearch &&
    parentCity &&
    normalizedTitle.includes(parentCity)
  );
}

async function assertGoogleDestinationScope(page, search) {
  const title = await page.title();
  if (googleDestinationScopeMatches(title, search)) return;
  throw new Error(
    `Google Hotels abrio una zona distinta de ${search.searchArea || search.destination}. ` +
      `Pagina recibida: ${title || "sin titulo"}.`,
  );
}

function googleHotelLocationCacheKey(hotelName, search) {
  return [
    String(search.countryCode || "").toUpperCase(),
    normalizeGoogleQuery(hotelName),
    Number(search.originLatitude).toFixed(3),
    Number(search.originLongitude).toFixed(3),
  ].join(":");
}

function googleHotelNameMatches(hotelName, properties = {}) {
  const expected = normalizeGoogleQuery(hotelName);
  const candidateName = normalizeGoogleQuery(properties.name);
  if (!expected || !candidateName) return false;
  if (
    expected === candidateName ||
    (candidateName.length >= 4 && expected.startsWith(`${candidateName} `)) ||
    (expected.length >= 4 && candidateName.startsWith(`${expected} `))
  ) {
    return true;
  }

  const ignored = new Set([
    "hotel", "hotels", "hostel", "resort", "apartments", "apartamentos",
    "the", "de", "del", "do", "da", "la", "el", "and", "spa",
  ]);
  const tokens = (value) => normalizeGoogleQuery(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !ignored.has(token));
  const expectedTokens = tokens(hotelName);
  const candidateText = [
    properties.name,
    properties.street,
    properties.district,
    properties.city,
    properties.town,
    properties.village,
  ].join(" ");
  const candidateTokens = new Set(tokens(candidateText));
  const matches = expectedTokens.filter((token) => candidateTokens.has(token));
  return expectedTokens.length > 1 && matches.length / expectedTokens.length >= 0.75;
}

function selectGoogleHotelLocation(payload, hotelName, search) {
  const expectedCountry = String(search.countryCode || "").toUpperCase();
  const originLatitude = Number(search.originLatitude);
  const originLongitude = Number(search.originLongitude);
  if (!Number.isFinite(originLatitude) || !Number.isFinite(originLongitude)) {
    return null;
  }

  return (payload?.features || [])
    .flatMap((feature) => {
      const properties = feature?.properties || {};
      const coordinates = feature?.geometry?.coordinates || [];
      const longitude = Number(coordinates[0]);
      const latitude = Number(coordinates[1]);
      const countryCode = String(properties.countrycode || "").toUpperCase();
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        (expectedCountry && countryCode && countryCode !== expectedCountry) ||
        !googleHotelNameMatches(hotelName, properties)
      ) {
        return [];
      }
      const distanceKm = distanceBetweenCoordinates(
        originLatitude,
        originLongitude,
        latitude,
        longitude,
      );
      return [{
        latitude,
        longitude,
        distanceKm: Math.round(distanceKm * 100) / 100,
        address: [
          properties.street,
          properties.city || properties.town || properties.village,
          properties.country,
        ].filter(Boolean).join(", "),
      }];
    })
    .sort((left, right) => left.distanceKm - right.distanceKm)[0] || null;
}

async function resolveGoogleHotelLocation(hotelName, search, options = {}) {
  const cache = options.locationCache || {};
  const cacheKey = googleHotelLocationCacheKey(hotelName, search);
  const cached = cache[cacheKey];
  const cachedAt = Date.parse(cached?.resolvedAt || "");
  const cacheLifetime = cached?.miss
    ? NEGATIVE_LOCATION_CACHE_MS
    : POSITIVE_LOCATION_CACHE_MS;
  if (Number.isFinite(cachedAt) && Date.now() - cachedAt < cacheLifetime) {
    return cached.miss ? null : cached;
  }

  const country = String(search.destination || "").split(",").at(-1)?.trim();
  const queries = Array.from(new Set([
    [hotelName, search.searchArea, country].filter(Boolean).join(", "),
    [hotelName, country].filter(Boolean).join(", "),
  ]));
  const fetchImpl = options.fetchImpl || fetch;
  let location = null;
  for (const query of queries) {
    try {
      const url = new URL(PHOTON_SEARCH_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "5");
      const response = await fetchImpl(url, {
        headers: {
          accept: "application/json",
          "user-agent": "TarifaRadar/1.0 (hotel distance validation)",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) continue;
      location = selectGoogleHotelLocation(
        await response.json(),
        hotelName,
        search,
      );
      if (location) break;
    } catch {
      // A map outage must not turn an unverified location into a valid offer.
    }
  }

  cache[cacheKey] = location
    ? { ...location, resolvedAt: new Date().toISOString() }
    : { miss: true, resolvedAt: new Date().toISOString() };
  return location;
}

function applyGoogleHotelLocation(offer, location, search) {
  if (location) {
    offer.latitude = location.latitude;
    offer.longitude = location.longitude;
    offer.distanceKm = location.distanceKm;
    offer.distanceVerified = true;
    if (location.address) offer.address = location.address;
  }
  offer.matches = matchesSearch(offer, search);
  offer.candidateMatches = offer.matches;
  return offer;
}

async function enrichGoogleOfferLocations(offers, search, options = {}) {
  const candidates = offers
    .slice()
    .sort((left, right) => left.totalPrice - right.totalPrice)
    .slice(0, MAX_GOOGLE_LOCATION_CANDIDATES);
  let matchingLocations = 0;
  for (const offer of candidates) {
    const location = await resolveGoogleHotelLocation(
      offer.hotelName,
      search,
      options,
    );
    applyGoogleHotelLocation(offer, location, search);
    if (offer.matches) matchingLocations += 1;
    if (matchingLocations >= search.maxVerifiedResults) break;
  }
  return offers;
}

async function selectGoogleHotelsDestination(page, search, timeoutMs) {
  const destination = search.destination.split(",")[0].trim();
  const query = `hoteles en ${destination}`;
  const destinationInput = page
    .getByRole("combobox", { name: /Busca sitios|Search for places/i })
    .first();
  await destinationInput.waitFor({ state: "visible", timeout: timeoutMs });
  await destinationInput.fill(query);
  const options = page.getByRole("option");
  await options.first().waitFor({
    state: "visible",
    timeout: Math.min(timeoutMs, 10_000),
  });
  const labels = await options.allTextContents();
  const normalizedQuery = normalizeGoogleQuery(query);
  const normalizedDestination = normalizeGoogleQuery(destination);
  const exactForms = new Set([
    normalizedQuery,
    `hotels in ${normalizedDestination}`,
    `${normalizedDestination} hotels`,
  ]);
  let selectedIndex = labels.findIndex((label) =>
    exactForms.has(normalizeGoogleQuery(label)),
  );
  if (selectedIndex < 0) {
    const candidates = labels
      .map((label, index) => ({
        index,
        label: normalizeGoogleQuery(label),
      }))
      .filter(({ label }) =>
        label.includes(normalizedDestination) &&
        /hotel|hoteles/.test(label),
      )
      .sort((left, right) => left.label.length - right.label.length);
    selectedIndex = candidates[0]?.index ?? -1;
  }
  if (selectedIndex < 0) {
    throw new Error(
      `Google Hotels no reconocio el destino ${destination}. ` +
        `Sugerencias: ${labels.slice(0, 3).join(" | ") || "ninguna"}.`,
    );
  }
  await options.nth(selectedIndex).click();
  await page.waitForTimeout(1_500);
}

async function ensureCalendarDate(page, isoDate, timeoutMs) {
  const selector = `[role="gridcell"][data-iso="${isoDate}"]`;
  const calendar = page
    .locator('[role="dialog"]:visible')
    .filter({ has: page.locator('[role="gridcell"][data-iso]') })
    .last();
  const targetDate = new Date(`${isoDate}T12:00:00Z`);
  const today = new Date();
  const monthsAhead = Number.isFinite(targetDate.getTime())
    ? Math.max(
        0,
        (targetDate.getUTCFullYear() - today.getUTCFullYear()) * 12 +
          targetDate.getUTCMonth() - today.getUTCMonth(),
      )
    : 18;
  const maximumAdvances = Math.min(24, Math.max(18, monthsAhead + 3));
  for (let month = 0; month < maximumAdvances; month += 1) {
    const attachedDate = calendar.locator(selector).first();
    if (await attachedDate.count()) {
      // Google's current calendar renders many months in one vertical dialog.
      // Only cells inside the viewport have aria-hidden="false", so reveal the
      // already attached date instead of looking for a non-existent next button.
      await attachedDate.evaluate((cell) =>
        cell.scrollIntoView({ block: "center", inline: "center" })
      );
      await page.waitForTimeout(150);
      const visibleDate = calendar
        .locator(`${selector}[aria-hidden="false"]`)
        .first();
      return (await visibleDate.count()) ? visibleDate : attachedDate;
    }
    let nextButton = calendar
      .getByRole("button", {
        name: /Siguiente|Next|Mes siguiente|Next month|Avanzar|Navigate forward/i,
      })
      .first();
    if (!(await nextButton.count())) {
      nextButton = page
        .getByRole("button", {
          name: /Siguiente|Next|Mes siguiente|Next month|Avanzar|Navigate forward/i,
        })
        .last();
    }
    if (!(await nextButton.count()) || await nextButton.isDisabled()) break;
    const firstVisibleDate = await calendar
      .locator('[role="gridcell"][data-iso][aria-hidden="false"]')
      .first()
      .getAttribute("data-iso")
      .catch(() => "");
    await nextButton.click({ force: true }).catch(async () => {
      await nextButton.evaluate((button) => button.click());
    });
    for (let wait = 0; wait < 6; wait += 1) {
      await page.waitForTimeout(100);
      const currentFirstDate = await calendar
        .locator('[role="gridcell"][data-iso][aria-hidden="false"]')
        .first()
        .getAttribute("data-iso")
        .catch(() => "");
      if (!firstVisibleDate || currentFirstDate !== firstVisibleDate) break;
    }
  }
  throw new Error(
    `Google Hotels no mostro la fecha ${isoDate} en el calendario.`,
    { cause: new Error(`Timeout ${timeoutMs}ms`) },
  );
}

async function clickCalendarDate(page, isoDate, timeoutMs) {
  const dateButton = await ensureCalendarDate(page, isoDate, timeoutMs);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await dateButton.evaluate((cell) => cell.click());
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.waitForTimeout(100);
    }
  }
}

async function selectGoogleHotelsDates(page, search, timeoutMs) {
  const entry = page
    .getByRole("textbox", { name: /Entrada|Check-in/i })
    .first();
  await entry.waitFor({ state: "visible", timeout: timeoutMs });
  await entry.evaluate((element) => element.click());
  const calendar = page
    .locator('[role="dialog"]:visible')
    .filter({ has: page.locator('[role="gridcell"][data-iso]') })
    .last();
  await calendar.waitFor({
    state: "visible",
    timeout: timeoutMs,
  });

  await clickCalendarDate(page, search.checkIn, timeoutMs);
  await clickCalendarDate(page, search.checkOut, timeoutMs);

  const selectedCheckIn = calendar.locator(
    `[role="gridcell"][data-iso="${search.checkIn}"]` +
      '[aria-selected="true"]',
  );
  const selectedCheckOut = calendar.locator(
    `[role="gridcell"][data-iso="${search.checkOut}"]` +
      '[aria-selected="true"]',
  );
  if (!(await selectedCheckIn.count()) || !(await selectedCheckOut.count())) {
    throw new Error("Google Hotels no mantuvo las fechas solicitadas.");
  }

  const doneButton = page
    .locator('[role="dialog"]:visible')
    .filter({ has: page.locator('[role="gridcell"][data-iso]') })
    .last()
    .locator("button")
    .filter({ hasText: /^\s*(?:Hecho|Done)\s*$/i })
    .first();
  await doneButton.evaluate((button) => button.click());
  await calendar.waitFor({
    state: "hidden",
    timeout: timeoutMs,
  }).catch(() => {});
}

async function openGoogleTravelersDialog(page, timeoutMs) {
  const travelerDialogs = () => page
    .locator('[role="dialog"]:visible')
    .filter({
      has: page.getByRole("button", {
        name: /Quitar adulto|Remove adult/i,
      }),
    });
  let dialog = travelerDialogs().last();
  if (await dialog.count()) return dialog;

  const travelersButton = page
    .getByRole("button", {
      name: /Numero de viajeros|N[u\u00fa]mero de viajeros|Number of travelers/i,
    })
    .first();
  await travelersButton.waitFor({ state: "visible", timeout: timeoutMs });
  await travelersButton.evaluate((element) => element.click());
  dialog = travelerDialogs().last();
  await dialog.waitFor({ state: "visible", timeout: timeoutMs });
  return dialog;
}

async function setGoogleTravelerCount(
  page,
  { removeName, addName, target, timeoutMs },
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const dialog = await openGoogleTravelersDialog(page, timeoutMs);
    const removeButton = dialog
      .getByRole("button", { name: removeName })
      .first();
    const counterText = await removeButton.evaluate((element) => {
      let container = element.parentElement;
      for (let level = 0; level < 5 && container; level += 1) {
        const text = (container.innerText || container.textContent || "").trim();
        if (/\b\d+\b/.test(text)) return text;
        container = container.parentElement;
      }
      return "";
    });
    const current = Number(counterText.match(/\b\d+\b/)?.[0]);
    if (!Number.isFinite(current)) {
      throw new Error("Google Hotels no mostro el contador de viajeros.");
    }
    if (current === target) return;

    const button = current > target
      ? removeButton
      : dialog.getByRole("button", { name: addName }).first();
    await button.evaluate((element) => element.click());
    await page.waitForTimeout(150);
  }
  throw new Error("Google Hotels no mantuvo la ocupacion solicitada.");
}

async function selectGoogleHotelsGuests(page, search, timeoutMs) {
  if (search.rooms !== 1) {
    throw new Error(
      "Google Hotels automatico admite por ahora una habitacion por busqueda.",
    );
  }

  await openGoogleTravelersDialog(page, timeoutMs);
  await setGoogleTravelerCount(page, {
    removeName: /Quitar adulto|Remove adult/i,
    addName: /A[n\u00f1]adir persona adulta|Add adult/i,
    target: search.adults,
    timeoutMs,
  });
  await setGoogleTravelerCount(page, {
    removeName: /Quitar ni[n\u00f1]o|Remove child/i,
    addName: /A[n\u00f1]adir ni[n\u00f1]o|Add child/i,
    target: search.children,
    timeoutMs,
  });

  const dialog = await openGoogleTravelersDialog(page, timeoutMs);
  const childAgeSelectors = dialog.getByRole("listbox", {
    name: /Edad del ni[n\u00f1]o|Child age/i,
  });
  for (let child = 0; child < await childAgeSelectors.count(); child += 1) {
    await childAgeSelectors.nth(child).evaluate((element) => element.click());
    const ageSeven = dialog
      .locator('[role="listbox"][aria-expanded="true"] [role="option"]')
      .filter({ hasText: /^\s*7\s*$/ })
      .first();
    if (await ageSeven.count()) {
      await ageSeven.evaluate((element) => element.click());
    }
  }

  await dialog
    .getByRole("button", { name: /Hecho|Done/i })
    .first()
    .evaluate((element) => element.click());
  await dialog.waitFor({ state: "hidden", timeout: timeoutMs }).catch(() => {});
}

async function extractGoogleHotelCards(page, search) {
  const currentSearchUrl = page.url();
  const rawCards = await page.locator("h2").evaluateAll(
    (headings, limit) => headings.slice(0, limit + 5).flatMap((heading) => {
      if (/patrocinado|sponsored/i.test(heading.textContent || "")) return [];
      let container = heading;
      let totalLink = null;
      for (let level = 0; level < 9 && container; level += 1) {
        totalLink = Array.from(container.querySelectorAll("a")).find((link) =>
          /(?:en total|\btotal\b)/i.test(link.innerText || "") &&
          /noches?|nights?/i.test(link.innerText || "")
        );
        if (totalLink) break;
        container = container.parentElement;
      }
      if (!container || !totalLink) return [];
      const detailsLink = Array.from(container.querySelectorAll("a")).find(
        (link) =>
          /ver detalles de|view details (?:of|for)/i.test(
            link.getAttribute("aria-label") || "",
          ),
      );
      return [{
        hotelName: (heading.textContent || "").trim(),
        priceText: totalLink.innerText || "",
        text: container.innerText || "",
        labels: Array.from(container.querySelectorAll("[aria-label]"))
          .map((element) => element.getAttribute("aria-label") || "")
          .filter(Boolean),
        url: detailsLink?.href || totalLink.href || "",
      }];
    }),
    search.maxResults,
  );
  return rawCards
    .slice(0, search.maxResults)
    .map((card) => ({
      ...card,
      url: currentSearchUrl,
    }))
    .map((card) => buildGoogleOffer(card, search))
    .filter(Boolean);
}

async function extractGoogleHotelCandidates(page, search) {
  const rawCards = await page.locator("h2").evaluateAll(
    (headings, limit) => headings.slice(0, limit + 8).flatMap((heading) => {
      if (/patrocinado|sponsored/i.test(heading.textContent || "")) return [];
      const ordered = Array.from(document.querySelectorAll("h2, a"));
      const headingIndex = ordered.indexOf(heading);
      const previousHeadingIndex = ordered.findLastIndex(
        (element, index) => index < headingIndex && element.tagName === "H2",
      );
      const nextHeadingIndex = ordered.findIndex(
        (element, index) => index > headingIndex && element.tagName === "H2",
      );
      const precedingLinks = ordered
        .slice(previousHeadingIndex + 1, headingIndex)
        .filter((element) => element.tagName === "A");
      const cardElements = ordered.slice(
        headingIndex + 1,
        nextHeadingIndex < 0 ? undefined : nextHeadingIndex,
      );
      const links = cardElements.filter((element) => element.tagName === "A");
      const labelFor = (link) =>
        `${link.getAttribute("aria-label") || ""} ${link.innerText || ""}`
          .trim();
      const nightlyLink = links.find((link) =>
        /(?:precios de|prices (?:of|for)|a partir de|starting (?:at|from))/.test(
          labelFor(link).toLowerCase(),
        ) &&
        /(?:\u20ac|EUR)/i.test(labelFor(link))
      );
      const pricesLink = links.find((link) =>
        /(?:ver precios de|view prices (?:of|for))/.test(
          labelFor(link).toLowerCase(),
        )
      );
      const anyCurrencyLink = links.find((link) =>
        /(?:\u20ac|\bEUR\b)/i.test(labelFor(link))
      );
      const anyCurrencyText = cardElements
        .map((element) => element.innerText || "")
        .find((text) => /(?:\u20ac|\bEUR\b)/i.test(text));
      const hotelName = (heading.textContent || "").trim();
      const normalizedHotelName = hotelName.toLowerCase();
      const hotelLink = precedingLinks.reverse().find((link) =>
        labelFor(link).toLowerCase().includes(normalizedHotelName) &&
        /\/travel\/search/i.test(link.href || "")
      );
      let pricePageUrl = pricesLink?.href || "";
      if (!pricePageUrl && hotelLink?.href) {
        const url = new URL(hotelLink.href);
        url.searchParams.set("ap", "MAC6AQZwcmljZXM");
        pricePageUrl = url.toString();
      }
      if (!pricePageUrl) return [];
      const nextHeading =
        nextHeadingIndex < 0 ? null : ordered[nextHeadingIndex];
      const labels = Array.from(document.querySelectorAll("[aria-label]"))
        .filter((element) => {
          const followsCurrent =
            heading.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING;
          const precedesNext =
            !nextHeading ||
            element.compareDocumentPosition(nextHeading) &
            Node.DOCUMENT_POSITION_FOLLOWING;
          return followsCurrent && precedesNext;
        })
        .map((element) => element.getAttribute("aria-label") || "")
        .filter(Boolean);
      return [{
        hotelName,
        nightlyText:
          nightlyLink?.innerText ||
          nightlyLink?.getAttribute("aria-label") ||
          (anyCurrencyLink ? labelFor(anyCurrencyLink) : "") ||
          anyCurrencyText ||
          "",
        text: cardElements
          .map((element) => element.innerText || "")
          .filter(Boolean)
          .join("\n"),
        labels,
        pricePageUrl,
      }];
    }),
    search.maxResults,
  );

  return rawCards
    .map((card) => ({
      ...card,
      nightlyPrice: parseGoogleHotelsNightly(
        String(card.nightlyText).replace(/^.*?(?=\d[\d.,\s]*\s*\u20ac)/, ""),
      ) || parseGoogleCandidateNightly(card.nightlyText),
    }))
    .filter((card) => card.hotelName && card.pricePageUrl);
}

function googleCandidateMatches(card, search, options = {}) {
  const estimatedNightly = card.nightlyPrice || 1;
  const estimatedTotal =
    Math.round(estimatedNightly * search.nights * 100) / 100;
  const candidateSearch = {
    ...search,
    ...(options.ignoreBudget ? { maxTotal: 0, maxNightly: 0 } : {}),
    ...(options.ignoreDistance
      ? { maxDistanceKm: 0, locationRadiusKm: 0 }
      : {}),
    ...(options.ignoreIncompleteCardDetails
      ? {
          minStars: 0,
          guestRatingMin: 0,
          freeCancellation: false,
          mealPlan: "any",
          propertyTypes: [],
          amenities: [],
        }
      : {}),
  };
  const provisional = buildGoogleOffer(
    {
      hotelName: card.hotelName,
      priceText:
        `${estimatedNightly} \u20ac${estimatedTotal} \u20ac en total` +
        `${search.nights} noches con impuestos y tasas incluidos`,
      text: card.text,
      labels: card.labels,
      url: card.pricePageUrl,
    },
    candidateSearch,
  );
  return Boolean(provisional?.matches);
}

function providerNameFromText(value) {
  return String(value || "")
    .split(
      /\r?\n|(?=(?:EUR\s*|\u20ac)\d)|(?=\d+\s+(?:hu\u00e9spedes?|guests?))/i,
    )[0]
    .trim() || "Proveedor";
}

function googleProviderCanSupplyVerifiedTotal(value) {
  return !/\bTripening(?:\s+Hotels)?\b/i.test(String(value || ""));
}

function googleVerificationOnlyLocationFiltered(verification) {
  return Boolean(
    Number(verification?.selectedCount) > 0 &&
    Number(verification?.locationFilteredCount) ===
      Number(verification?.selectedCount)
  );
}

function verifiedGoogleProviderPrice(link, search) {
  const linkedTotal = parseGoogleProviderInclusiveTotal(
    `${link.href || ""}\n${link.text || ""}`,
  );
  if (linkedTotal && providerLinkMatchesStay(link.href, search)) {
    return { totalPrice: linkedTotal, evidence: "provider_link" };
  }

  // Google sometimes keeps the exact stay in page state instead of repeating
  // it in the outbound URL. The visible row still names the taxed stay total.
  const visibleTotal = parseGoogleProviderVisibleTotal(link.text);
  const visibleGuests = String(link.text || "").match(
    /(\d+)\s+(?:hu[e\u00e9]spedes?|guests?)/i,
  )?.[1];
  if (
    visibleGuests &&
    Number(visibleGuests) !== search.adults + search.children
  ) {
    return null;
  }
  return visibleTotal
    ? { totalPrice: visibleTotal, evidence: "visible_provider_row" }
    : null;
}

function providerLinkMatchesStay(value, search) {
  const text = repeatedlyDecodeUrl(value).join("\n");
  const dateFromParts = (prefix) => {
    const day = text.match(
      new RegExp(`(?:^|[?&])${prefix}(?:_|)day=([0-9]{1,2})`, "i"),
    )?.[1];
    const month = text.match(
      new RegExp(`(?:^|[?&])${prefix}(?:_|)month=([0-9]{1,2})`, "i"),
    )?.[1];
    const year = text.match(
      new RegExp(`(?:^|[?&])${prefix}(?:_|)year=([0-9]{4})`, "i"),
    )?.[1];
    return day && month && year
      ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
      : "";
  };
  const isoCheckIn = text.match(
    /(?:checkin|check_in|checkin_at|arrival_date|startdate)=([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
  )?.[1] || dateFromParts("(?:checkin|ckin)");
  const isoCheckOut = text.match(
    /(?:checkout|check_out|checkout_at|departure_date|enddate)=([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
  )?.[1] || dateFromParts("(?:checkout|ckout)");
  if (isoCheckIn !== search.checkIn || isoCheckOut !== search.checkOut) {
    return false;
  }

  const adults = text.match(
    /(?:^|[?&])(?:num_adults|numberofadults|group_adults|req_adults|adults|adult)=([0-9]+)/i,
  )?.[1];
  if (adults && Number(adults) !== search.adults) return false;
  if (!adults && search.adults !== 2) return false;

  const childrenValue = text.match(
    /(?:^|[?&])(?:num_children|numberofchildren|group_children|req_children|children|ch)=([^&\s]*)/i,
  )?.[1];
  if (childrenValue !== undefined) {
    const decodedChildren = decodeURIComponent(childrenValue);
    const childCount = /^\d+$/.test(decodedChildren)
      ? Number(decodedChildren)
      : (decodedChildren.match(/(?:\d+_\d+)|(?:\b\d{1,2}\b)/g) || []).length;
    if (childCount !== search.children) return false;
  } else if (search.children > 0) {
    return false;
  }

  const rooms = text.match(
    /(?:^|[?&])(?:num_rooms|numberofrooms|no_rooms)=([0-9]+)/i,
  )?.[1];
  if (rooms && Number(rooms) !== search.rooms) return false;
  if (!rooms && search.rooms !== 1) return false;
  return true;
}

async function verifyGoogleHotelCandidates(page, candidates, search, options = {}) {
  const timeoutMs = Math.min(options.timeoutMs || 25_000, 25_000);
  const pricedCandidates = candidates
    .sort(
      (left, right) =>
        (left.nightlyPrice || Infinity) -
        (right.nightlyPrice || Infinity),
    );
  const visibleFilterMatches = pricedCandidates.filter((candidate) =>
    googleCandidateMatches(candidate, search, {
      ignoreBudget: true,
      ignoreDistance: true,
    })
  );
  const incompleteCardMatches = pricedCandidates.filter((candidate) =>
    googleCandidateMatches(candidate, search, {
      ignoreBudget: true,
      ignoreDistance: true,
      ignoreIncompleteCardDetails: true,
    })
  );
  const selected = Array.from(
    new Map(
      [...visibleFilterMatches, ...incompleteCardMatches].map((candidate) => [
        candidate.pricePageUrl,
        candidate,
      ]),
    ).values(),
  ).slice(
    0,
    MAX_GOOGLE_LOCATION_CANDIDATES,
  );
  const offers = [];
  const errors = [];

  for (const candidate of selected) {
    try {
      const location = await resolveGoogleHotelLocation(
        candidate.hotelName,
        search,
        options,
      );
      const distanceLimit = effectiveDistanceLimit(search);
      if (
        distanceLimit > 0 &&
        (!location || location.distanceKm > distanceLimit)
      ) {
        throw new Error(
          !location
            ? "No se pudo comprobar la distancia real de este hotel."
            : `El hotel esta a ${location.distanceKm} km y queda fuera del radio.`,
        );
      }
      await page.goto(candidate.pricePageUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      await selectGoogleHotelsDates(page, search, timeoutMs);
      const exactPricePageUrl = page.url();
      const providerLocator = page
        .locator("a")
        .filter({ hasText: /Visitar sitio web|Visit website/i });
      await providerLocator.first().waitFor({
        state: "attached",
        timeout: timeoutMs,
      });
      const providerLinks = await providerLocator.evaluateAll((links) =>
        links.map((link) => ({
          href: link.href || "",
          text: link.innerText || "",
        }))
      );
      const providerPrices = providerLinks.flatMap((link) => {
        if (!googleProviderCanSupplyVerifiedTotal(link.text)) return [];
        const verifiedPrice = verifiedGoogleProviderPrice(link, search);
        if (!verifiedPrice) return [];
        return [{
          ...verifiedPrice,
          provider: providerNameFromText(link.text),
          href: link.href,
          text: link.text,
        }];
      })
        .filter((price) =>
          !candidate.nightlyPrice ||
          googleTotalMatchesNightly(
            price.totalPrice,
            candidate.nightlyPrice,
            search.nights,
          )
        )
        .sort((left, right) => left.totalPrice - right.totalPrice);
      const bestProvider = providerPrices[0];
      if (!bestProvider) {
        throw new Error(
          "Google no expuso un total final con impuestos en EUR.",
        );
      }

      const detailText = await page.locator("body").innerText().catch(() => "");
      const detailLabels = await page
        .locator("[aria-label]")
        .evaluateAll((elements) =>
          elements
            .map((element) => element.getAttribute("aria-label") || "")
            .filter(Boolean)
        )
        .catch(() => []);
      const offer = buildGoogleOffer(
        {
          hotelName: candidate.hotelName,
          priceText:
            `${candidate.nightlyPrice || bestProvider.totalPrice / search.nights} \u20ac` +
            `${bestProvider.totalPrice} \u20ac en total` +
            `${search.nights} noches con impuestos y tasas incluidos`,
          text: `${candidate.text}\n${detailText}\n${bestProvider.text}`,
          labels: [...candidate.labels, ...detailLabels],
          url: candidate.pricePageUrl,
        },
        search,
      );
      if (!offer) {
        throw new Error("Google cambio el hotel o las fechas al verificarlo.");
      }
      offer.provider = `${bestProvider.provider} via Google Hotels`;
      offer.priceBasis = "google_hotels_provider_all_inclusive_v7";
      offer.priceEvidence = bestProvider.evidence;
      offer.displayedNightlyPrice = candidate.nightlyPrice;
      offer.url = bestProvider.evidence === "provider_link"
        ? bestProvider.href
        : exactPricePageUrl;
      applyGoogleHotelLocation(offer, location, search);
      offers.push(offer);
      if (offers.length >= search.maxVerifiedResults) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({
        hotelName: candidate.hotelName,
        message,
        kind: /distancia real|fuera del radio/i.test(message)
          ? "location_filtered"
          : "verification_failed",
      });
    }
  }

  return {
    selectedCount: selected.length,
    locationFilteredCount: errors.filter(
      (error) => error.kind === "location_filtered",
    ).length,
    offers,
    errors,
  };
}

async function googleHotelsDiagnostics(page) {
  return page.evaluate(() => ({
    headings: Array.from(document.querySelectorAll("h2"))
      .map((heading) => (heading.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 4),
    prices: Array.from(document.querySelectorAll("a"))
      .map((link) => (link.innerText || "").trim().replace(/\s+/g, " "))
      .filter((text) => /[\u20ac$]|total|nights?|noches?/i.test(text))
      .slice(0, 4),
  }));
}

async function loadGoogleHotels(page, search, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const searchUrl = buildGoogleHotelsSearchUrl(search);
  const attempts = 2;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const loadAttempt = googleHotelsLoadAttempt(searchUrl, attempt);
      await page.goto(loadAttempt.url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      await acceptGoogleConsent(page);
      if (/Error 500/i.test(await page.title())) {
        await page.goto(loadAttempt.url, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
        await acceptGoogleConsent(page);
      }
      await selectGoogleHotelsCurrency(page, timeoutMs);
      if (loadAttempt.selectDestination) {
        await selectGoogleHotelsDestination(page, search, timeoutMs);
      } else {
        await page.waitForTimeout(1_500);
      }
      await selectGoogleHotelsGuests(page, search, timeoutMs);
      await selectGoogleHotelsDates(page, search, timeoutMs);
      await page.locator("h2").nth(1).waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
      await assertGoogleDestinationScope(page, search);
      let previousHeadingCount = 0;
      let stablePasses = 0;
      for (let pass = 0; pass < 5; pass += 1) {
        const headingCount = await page.locator("h2").count();
        if (headingCount >= search.maxResults) break;
        stablePasses = headingCount === previousHeadingCount
          ? stablePasses + 1
          : 0;
        if (stablePasses >= 2) break;
        previousHeadingCount = headingCount;
        await page.mouse.wheel(0, 1_400);
        await page.waitForTimeout(700);
      }
      await page.waitForTimeout(500);
      return { searchUrl, resultUrl: page.url() };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await page.waitForTimeout(800);
    }
  }
  throw new Error(
    "Google Hotels no ha mostrado resultados para las fechas solicitadas." +
      (lastError
        ? ` Motivo: ${lastError instanceof Error ? lastError.message : String(lastError)}`
        : ""),
    { cause: lastError },
  );
}

async function scrapeGoogleHotels(input, options = {}) {
  const search = normalizeSearch(input);
  if (search.rooms !== 1) {
    throw new Error(
      "Google Hotels automatico admite por ahora una habitacion por busqueda.",
    );
  }
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
    const { searchUrl, resultUrl } = await loadGoogleHotels(
      page,
      search,
      options,
    );
    let offers = options.forceProviderVerification
      ? []
      : await extractGoogleHotelCards(page, search);
    if (offers.length) {
      offers = await enrichGoogleOfferLocations(offers, search, options);
    }
    let verificationErrors = [];
    if (!offers.length) {
      const candidates = await extractGoogleHotelCandidates(page, search);
      if (!candidates.length) {
        const diagnostics = await googleHotelsDiagnostics(page);
        throw new Error(
          "Google Hotels abrio la busqueda pero no mostro tarjetas de hotel verificables. " +
            `Titulos: ${diagnostics.headings.join(" | ") || "ninguno"}. ` +
            `Precios: ${diagnostics.prices.join(" | ") || "ninguno"}.`,
        );
      }
      const verification = await verifyGoogleHotelCandidates(
        page,
        candidates,
        search,
        options,
      );
      offers = verification.offers;
      verificationErrors = verification.errors;
      if (!verification.selectedCount) {
        return {
          source: GOOGLE_SOURCE,
          searchedAt: new Date().toISOString(),
          search,
          searchUrl,
          resultUrl,
          searchedPages: 1,
          offers: [],
          matchingOffers: [],
          verificationErrors: [],
          cheapestOffer: null,
        };
      }
      if (!offers.length && googleVerificationOnlyLocationFiltered(verification)) {
        return {
          source: GOOGLE_SOURCE,
          searchedAt: new Date().toISOString(),
          search,
          searchUrl,
          resultUrl,
          searchedPages: 1,
          offers: [],
          matchingOffers: [],
          verificationErrors,
          cheapestOffer: null,
        };
      }
    }
    if (!offers.length) {
      const diagnostics = await googleHotelsDiagnostics(page);
      throw new Error(
        "Google Hotels abrio la busqueda pero no expuso un total final verificable. " +
          `Titulos: ${diagnostics.headings.join(" | ") || "ninguno"}. ` +
          `Precios: ${diagnostics.prices.join(" | ") || "ninguno"}. ` +
          `Detalle: ${verificationErrors[0]?.message || "sin proveedores compatibles"}.`,
      );
    }
    const matchingOffers = offers
      .filter((offer) => offer.matches)
      .sort((left, right) => left.totalPrice - right.totalPrice);
    return {
      source: GOOGLE_SOURCE,
      searchedAt: new Date().toISOString(),
      search,
      searchUrl,
      resultUrl,
      searchedPages: 1,
      offers,
      matchingOffers,
      verificationErrors,
      cheapestOffer: offers
        .slice()
        .sort((left, right) => left.totalPrice - right.totalPrice)[0] || null,
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  GOOGLE_SOURCE,
  buildGoogleHotelsSearchUrl,
  buildGoogleOffer,
  extractGoogleHotelCards,
  extractGoogleHotelCandidates,
  googleHotelNameMatches,
  googleDestinationScopeMatches,
  googleVerificationOnlyLocationFiltered,
  googleHotelsDiagnostics,
  googleHotelsLoadAttempt,
  googleCandidateMatches,
  googleProviderCanSupplyVerifiedTotal,
  googleTotalMatchesNightly,
  parseGoogleGuestRating,
  parseGoogleCandidateNightly,
  parseGoogleHotelsNightly,
  parseGoogleHotelsNights,
  parseGoogleProviderInclusiveTotal,
  parseGoogleProviderVisibleTotal,
  parseGoogleHotelsTotal,
  parseGoogleReviewCount,
  parseGoogleStars,
  providerLinkMatchesStay,
  selectGoogleHotelLocation,
  verifiedGoogleProviderPrice,
  scrapeGoogleHotels,
  selectGoogleHotelsCurrency,
  selectGoogleHotelsGuests,
  selectGoogleHotelsDates,
  stableOfferId,
};
