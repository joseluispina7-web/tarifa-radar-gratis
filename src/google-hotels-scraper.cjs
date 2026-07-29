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
const MAX_GOOGLE_DETAIL_CANDIDATES = 3;
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
        /(?:currency|display_currency|divisa)=([A-Z]{3})/gi,
      ),
    );
    if (
      currencyMatches.length &&
      currencyMatches.some((match) => match[1].toUpperCase() !== "EUR")
    ) {
      continue;
    }
    const match = candidate.match(
      /(?:display_all_inclusive_price|all_inclusive_price|grand_total|total_including_taxes|total_with_taxes)=([\d.,]+)/i,
    );
    if (match) return parseLocalizedNumber(match[1]);
  }
  return 0;
}

function parseGoogleHotelsNights(value) {
  const match = String(value || "").match(/(\d+)\s+(?:noches?|nights?)/i);
  return match ? Number(match[1]) : 0;
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
  const includesTaxes =
    /impuestos y tasas incluidos|taxes and fees included|including taxes and fees/i.test(
      String(card.priceText || ""),
    );
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
  const selector =
    `[role="dialog"]:visible [role="gridcell"][data-iso="${isoDate}"]` +
    '[aria-hidden="false"] [role="button"]';
  for (let month = 0; month < 15; month += 1) {
    const dateButton = page.locator(selector).first();
    if (await dateButton.count()) return selector;
    const nextButton = page
      .locator('[role="dialog"]:visible')
      .getByRole("button", { name: /Siguiente|Next/i })
      .first();
    if (!(await nextButton.count())) break;
    await nextButton.evaluate((button) => button.click());
    await page.waitForTimeout(120);
  }
  throw new Error(
    `Google Hotels no mostro la fecha ${isoDate} en el calendario.`,
    { cause: new Error(`Timeout ${timeoutMs}ms`) },
  );
}

async function clickCalendarDate(page, isoDate, timeoutMs) {
  const selector = await ensureCalendarDate(page, isoDate, timeoutMs);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.locator(selector).first().evaluate((button) => button.click());
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
  await page.locator('[role="dialog"]:visible').first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });

  await clickCalendarDate(page, search.checkIn, timeoutMs);
  await clickCalendarDate(page, search.checkOut, timeoutMs);

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
  await doneButton.evaluate((button) => button.click());
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
    .map((card) => buildGoogleOffer(card, search))
    .filter(Boolean);
}

async function extractGoogleHotelCandidates(page, search) {
  const rawCards = await page.locator("h2").evaluateAll(
    (headings, limit) => headings.slice(0, limit + 8).flatMap((heading) => {
      if (/patrocinado|sponsored/i.test(heading.textContent || "")) return [];
      const ordered = Array.from(document.querySelectorAll("h2, a"));
      const headingIndex = ordered.indexOf(heading);
      const nextHeadingIndex = ordered.findIndex(
        (element, index) => index > headingIndex && element.tagName === "H2",
      );
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
      if (!nightlyLink || !pricesLink) return [];
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
        hotelName: (heading.textContent || "").trim(),
        nightlyText:
          nightlyLink.innerText ||
          nightlyLink.getAttribute("aria-label") ||
          "",
        text: cardElements
          .map((element) => element.innerText || "")
          .filter(Boolean)
          .join("\n"),
        labels,
        pricePageUrl: pricesLink.href || "",
      }];
    }),
    search.maxResults,
  );

  return rawCards
    .map((card) => ({
      ...card,
      nightlyPrice: parseGoogleHotelsNightly(
        String(card.nightlyText).replace(/^.*?(?=\d[\d.,\s]*\s*\u20ac)/, ""),
      ),
    }))
    .filter((card) =>
      card.hotelName && card.pricePageUrl && card.nightlyPrice > 0
    );
}

function googleCandidateMatches(card, search, options = {}) {
  const estimatedTotal =
    Math.round(card.nightlyPrice * search.nights * 100) / 100;
  const candidateSearch = options.ignoreBudget
    ? { ...search, maxTotal: 0, maxNightly: 0 }
    : search;
  const provisional = buildGoogleOffer(
    {
      hotelName: card.hotelName,
      priceText:
        `${card.nightlyPrice} \u20ac${estimatedTotal} \u20ac en total` +
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
    .split(/\r?\n|(?=\d+\s+(?:hu\u00e9spedes?|guests?))/i)[0]
    .trim() || "Proveedor";
}

function providerLinkMatchesStay(value, search) {
  const text = repeatedlyDecodeUrl(value).join("\n");
  const isoCheckIn = text.match(
    /(?:checkin|check_in|checkin_at|arrival_date)=([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
  )?.[1];
  const isoCheckOut = text.match(
    /(?:checkout|check_out|checkout_at|departure_date)=([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
  )?.[1];
  if (isoCheckIn && isoCheckIn !== search.checkIn) return false;
  if (isoCheckOut && isoCheckOut !== search.checkOut) return false;
  return true;
}

async function verifyGoogleHotelCandidates(page, candidates, search, options = {}) {
  const timeoutMs = Math.min(options.timeoutMs || 25_000, 25_000);
  const selected = candidates
    .filter((candidate) =>
      googleCandidateMatches(candidate, search, { ignoreBudget: true })
    )
    .sort((left, right) => left.nightlyPrice - right.nightlyPrice)
    .slice(
      0,
      Math.min(search.maxVerifiedResults, MAX_GOOGLE_DETAIL_CANDIDATES),
    );
  const offers = [];
  const errors = [];

  for (const candidate of selected) {
    try {
      await page.goto(candidate.pricePageUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      const providerLocator = page.locator(
        'a[href*="/travel/lodging/clk"][href*="pcurl="]',
      );
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
        const totalPrice = parseGoogleProviderInclusiveTotal(link.href);
        if (
          !totalPrice ||
          !providerLinkMatchesStay(link.href, search)
        ) {
          return [];
        }
        const averageNightly = totalPrice / search.nights;
        const displayedNightly = candidate.nightlyPrice;
        if (
          averageNightly < displayedNightly * 0.75 ||
          averageNightly > displayedNightly * 1.5
        ) {
          return [];
        }
        return [{
          totalPrice,
          provider: providerNameFromText(link.text),
        }];
      }).sort((left, right) => left.totalPrice - right.totalPrice);
      const bestProvider = providerPrices[0];
      if (!bestProvider) {
        throw new Error(
          "Google no expuso un total final con impuestos en EUR.",
        );
      }

      const offer = buildGoogleOffer(
        {
          hotelName: candidate.hotelName,
          priceText:
            `${candidate.nightlyPrice} \u20ac` +
            `${bestProvider.totalPrice} \u20ac en total` +
            `${search.nights} noches con impuestos y tasas incluidos`,
          text: candidate.text,
          labels: candidate.labels,
          url: candidate.pricePageUrl,
        },
        search,
      );
      if (!offer) {
        throw new Error("Google cambio el hotel o las fechas al verificarlo.");
      }
      offer.provider = `${bestProvider.provider} via Google Hotels`;
      offer.priceBasis = "google_hotels_provider_all_inclusive";
      offer.displayedNightlyPrice = candidate.nightlyPrice;
      offers.push(offer);
    } catch (error) {
      errors.push({
        hotelName: candidate.hotelName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { selectedCount: selected.length, offers, errors };
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
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(1_500);
      return { searchUrl, resultUrl: page.url() };
    } catch (error) {
      lastError = error;
      if (attempt === 0) await page.waitForTimeout(800);
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
    let offers = options.forceProviderVerification
      ? []
      : await extractGoogleHotelCards(page, search);
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
  googleHotelsDiagnostics,
  googleCandidateMatches,
  parseGoogleGuestRating,
  parseGoogleHotelsNightly,
  parseGoogleHotelsNights,
  parseGoogleProviderInclusiveTotal,
  parseGoogleHotelsTotal,
  parseGoogleReviewCount,
  parseGoogleStars,
  scrapeGoogleHotels,
  selectGoogleHotelsDates,
  stableOfferId,
};
