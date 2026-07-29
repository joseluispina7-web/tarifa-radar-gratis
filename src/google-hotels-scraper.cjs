const crypto = require("node:crypto");
const fs = require("node:fs");
const {
  detectAmenities,
  detectMealPlan,
  detectPropertyType,
  isSharedRoomText,
  matchesSearch,
  normalizeSearch,
  parseDistanceKm,
  parseLocalizedNumber,
} = require("./booking-scraper.cjs");

const DEFAULT_TIMEOUT_MS = 30_000;
const GOOGLE_SOURCE = "google_hotels";
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

function parseGoogleHotelsTotal(value) {
  const match = String(value || "").match(
    /([\d][\d.\s\u00a0]*(?:,\d{1,2})?)\s*\u20ac\s+en total/i,
  );
  return match ? parseLocalizedNumber(match[1]) : 0;
}

function parseGoogleHotelsNightly(value) {
  const match = String(value || "").match(
    /^\s*([\d][\d.\s\u00a0]*(?:,\d{1,2})?)\s*\u20ac/i,
  );
  return match ? parseLocalizedNumber(match[1]) : 0;
}

function parseGoogleHotelsNights(value) {
  const match = String(value || "").match(/(\d+)\s+noches?/i);
  return match ? Number(match[1]) : 0;
}

function parseGoogleGuestRating(value) {
  const match = String(value || "").match(
    /(\d(?:[,.]\d)?)\s+de\s+5\s+estrellas?/i,
  );
  return match
    ? Math.round(parseLocalizedNumber(match[1]) * 2 * 10) / 10
    : 0;
}

function parseGoogleStars(value) {
  const match = String(value || "").match(
    /hotel de\s+(\d(?:[,.]\d)?)\s+estrellas?/i,
  );
  return match ? parseLocalizedNumber(match[1]) : 0;
}

function parseGoogleReviewCount(value) {
  const match = String(value || "").match(
    /de\s+([\d.\s\u00a0]+)\s+rese\u00f1as?/i,
  );
  return match ? Math.round(parseLocalizedNumber(match[1])) : 0;
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
  const includesTaxes =
    /impuestos y tasas incluidos/i.test(String(card.priceText || ""));
  if (
    !card.hotelName ||
    !card.url ||
    !totalPrice ||
    displayedNights !== search.nights ||
    !includesTaxes
  ) {
    return null;
  }

  const text = `${card.text || ""}\n${(card.labels || []).join("\n")}`;
  const nightlyPrice =
    Math.round((totalPrice / search.nights) * 100) / 100;
  const displayedNightlyPrice = parseGoogleHotelsNightly(card.priceText);
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
    priceBasis: "google_hotels_total_with_taxes",
    priceConfirmationCount: 2,
    priceConfirmedAt: new Date().toISOString(),
    stars: parseGoogleStars(text),
    guestRating: parseGoogleGuestRating(text),
    reviewCount: parseGoogleReviewCount(text),
    distanceKm: parsedDistance > 0 ? parsedDistance : null,
    freeCancellation: /cancelaci\u00f3n gratis/i.test(text),
    breakfastIncluded: /desayuno incluido/i.test(text),
    limitedAvailability: false,
    propertyType: detectPropertyType(`${card.hotelName}\n${text}`),
    amenities: detectAmenities(text),
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
  offer.matches = matchesSearch(offer, search, {
    // Google lists accommodation for the selected place but does not expose a
    // reliable distance on every card. Nearby areas are searched separately.
    ignoreDistance: true,
  });
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

function normalizeGoogleQuery(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
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
  await options.first().waitFor({ state: "visible", timeout: timeoutMs });
  const labels = await options.allTextContents();
  const normalizedQuery = normalizeGoogleQuery(query);
  const exactIndex = labels.findIndex(
    (label) => normalizeGoogleQuery(label) === normalizedQuery,
  );
  if (exactIndex < 0) {
    throw new Error(
      `Google Hotels no reconocio el destino ${destination}.`,
    );
  }
  await options.nth(exactIndex).click();
  await page.waitForTimeout(1_500);
}

async function ensureCalendarDate(page, isoDate, timeoutMs) {
  const selector =
    `[role="dialog"]:visible [role="gridcell"][data-iso="${isoDate}"]` +
    '[aria-hidden="false"] [role="button"]';
  for (let month = 0; month < 15; month += 1) {
    const dateButton = page.locator(selector).first();
    if (await dateButton.count()) return dateButton;
    const nextButton = page
      .locator('[role="dialog"]:visible button[aria-label="Siguiente"]')
      .first();
    if (!(await nextButton.count())) break;
    await nextButton.click();
    await page.waitForTimeout(120);
  }
  throw new Error(
    `Google Hotels no mostro la fecha ${isoDate} en el calendario.`,
    { cause: new Error(`Timeout ${timeoutMs}ms`) },
  );
}

async function selectGoogleHotelsDates(page, search, timeoutMs) {
  const entry = page
    .getByRole("textbox", { name: /Entrada|Check-in/i })
    .first();
  await entry.waitFor({ state: "visible", timeout: timeoutMs });
  await entry.click();
  await page.locator('[role="dialog"]:visible').first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });

  const checkInButton = await ensureCalendarDate(
    page,
    search.checkIn,
    timeoutMs,
  );
  await checkInButton.click();
  const checkOutButton = await ensureCalendarDate(
    page,
    search.checkOut,
    timeoutMs,
  );
  await checkOutButton.click();

  const selectedCheckIn = page.locator(
    `[role="dialog"]:visible [role="gridcell"][data-iso="${search.checkIn}"]` +
      '[aria-selected="true"]',
  );
  const selectedCheckOut = page.locator(
    `[role="dialog"]:visible [role="gridcell"][data-iso="${search.checkOut}"]` +
      '[aria-selected="true"]',
  );
  if (!(await selectedCheckIn.count()) || !(await selectedCheckOut.count())) {
    throw new Error("Google Hotels no mantuvo las fechas solicitadas.");
  }

  const doneButton = page
    .locator('[role="dialog"]:visible button')
    .filter({ hasText: /^\s*(?:Hecho|Done)\s*$/i })
    .first();
  await doneButton.click();
  await page.locator('[role="dialog"]:visible').first().waitFor({
    state: "hidden",
    timeout: timeoutMs,
  }).catch(() => {});
}

async function extractGoogleHotelCards(page, search) {
  const rawCards = await page.locator("h2").evaluateAll(
    (headings, limit) => headings.slice(0, limit + 5).flatMap((heading) => {
      if (/patrocinado|sponsored/i.test(heading.textContent || "")) return [];
      let container = heading;
      let totalLink = null;
      for (let level = 0; level < 9 && container; level += 1) {
        totalLink = Array.from(container.querySelectorAll("a")).find((link) =>
          /en total/i.test(link.innerText || "") &&
          /noches?/i.test(link.innerText || "")
        );
        if (totalLink) break;
        container = container.parentElement;
      }
      if (!container || !totalLink) return [];
      const detailsLink = Array.from(container.querySelectorAll("a")).find(
        (link) => /ver detalles de/i.test(link.getAttribute("aria-label") || ""),
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
    .map((card) => buildGoogleOffer(card, search))
    .filter(Boolean);
}

async function loadGoogleHotels(page, search, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const searchUrl = buildGoogleHotelsSearchUrl(search);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(GOOGLE_HOTELS_SEED_URL, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      await acceptGoogleConsent(page);
      if (/Error 500/i.test(await page.title())) {
        await page.goto(GOOGLE_HOTELS_SEED_URL, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
      }
      await selectGoogleHotelsDestination(page, search, timeoutMs);
      await selectGoogleHotelsDates(page, search, timeoutMs);
      await page.locator("h2").nth(1).waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
      await page.waitForTimeout(1_500);
      return { searchUrl, resultUrl: page.url() };
    } catch (error) {
      lastError = error;
      if (attempt === 0) await page.waitForTimeout(800);
    }
  }
  throw new Error(
    "Google Hotels no ha mostrado resultados para las fechas solicitadas.",
    { cause: lastError },
  );
}

async function scrapeGoogleHotels(input, options = {}) {
  const search = normalizeSearch(input);
  if (search.adults !== 2 || search.children !== 0 || search.rooms !== 1) {
    throw new Error(
      "Google Hotels automatico admite por ahora 2 adultos, sin ninos y 1 habitacion.",
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
    const offers = await extractGoogleHotelCards(page, search);
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
      verificationErrors: [],
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
  parseGoogleGuestRating,
  parseGoogleHotelsNightly,
  parseGoogleHotelsNights,
  parseGoogleHotelsTotal,
  parseGoogleReviewCount,
  parseGoogleStars,
  scrapeGoogleHotels,
  selectGoogleHotelsDates,
  stableOfferId,
};
