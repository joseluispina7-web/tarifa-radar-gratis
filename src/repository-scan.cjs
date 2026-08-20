const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { scrapeBooking } = require("./booking-scraper.cjs");
const { scrapeGoogleHotels } = require("./google-hotels-scraper.cjs");
const {
  scrapeAgoda,
  scrapeBluepillow,
  scrapeTrip,
} = require("./bluepillow-scraper.cjs");
const { discoverNearbyLocations } = require("./nearby-locations.cjs");
const {
  annotateMarketPrices,
  applyPriceDropIntelligence,
  enrichDealComparisons,
} = require("./deal-intelligence.cjs");
const {
  bookingDiscoveryDates,
  buildMonitorScanRequests,
  flexibleSearchShape,
  monitorIsDue,
  monitorToSearch,
  rangeSearchShape,
} = require("./remote-scan.cjs");
const {
  googleDateEligibility,
  recordSourceFailure,
  recordSourceSuccess,
  sourceCanRun,
} = require("./source-health.cjs");

const REQUIRED_PRICE_CONFIRMATIONS = 2;
const PRICE_COMPARISON_EPSILON = 0.01;
const DATE_SWEEP_VERSION = 4;
const BLUEPILLOW_SOURCES = new Set(["agoda", "trip", "bluepillow"]);
const STRICT_PRICE_SOURCES = new Set(["booking", "google_hotels", "trip"]);
const CURRENT_BOOKING_PRICE_BASES = new Set([
  "booking_visible_final_total_v5",
]);
const CURRENT_GOOGLE_PRICE_BASES = new Set([
  "google_hotels_provider_all_inclusive_v7",
  "google_hotels_visible_all_inclusive_v7",
]);
const DIRECT_SEARCH_LIMITS = {
  booking: 2,
  google_hotels: 1,
};
const DEFAULT_SCAN_BUDGET_MS = 270_000;
const DEFAULT_REQUEST_RESERVE_MS = 45_000;
const DEFAULT_SOURCE_TIMEOUT_MS = 20_000;
const MAX_PRICE_HISTORY_SAMPLES = 24;
const AUTOMATIC_SCRAPERS = {
  booking: scrapeBooking,
  google_hotels: scrapeGoogleHotels,
  agoda: scrapeAgoda,
  trip: scrapeTrip,
  bluepillow: scrapeBluepillow,
};
const DISCOVERY_SOURCES = new Set(["agoda", "trip", "bluepillow"]);
const DIRECT_SOURCES = new Set(["booking", "google_hotels"]);

function sourceIsEnabledForMonitor(monitor, source) {
  return Boolean(
    AUTOMATIC_SCRAPERS[source] &&
      (monitor.strictPrices === false || STRICT_PRICE_SOURCES.has(source)),
  );
}

function priceWithinDiscoveryRange(offer, search, multiplier = 1.2) {
  const totalPrice = Number(offer.totalPrice);
  const nightlyPrice = Number(offer.nightlyPrice);
  const totalLimit = Number(search.maxTotal) || 0;
  const nightlyLimit = Number(search.maxNightly) || 0;
  const totalMatches = totalLimit > 0 && totalPrice <= totalLimit * multiplier;
  const nightlyMatches =
    nightlyLimit > 0 && nightlyPrice <= nightlyLimit * multiplier;
  if (totalLimit > 0 && nightlyLimit > 0 && search.priceRule === "and") {
    return totalMatches && nightlyMatches;
  }
  if (totalLimit > 0 || nightlyLimit > 0) {
    return totalMatches || nightlyMatches;
  }
  return true;
}

function resultHasPromisingCandidate(result, search) {
  if ((result?.matchingOffers || []).length) return true;
  return (result?.offers || []).some((offer) =>
    priceWithinDiscoveryRange(offer, search)
  );
}

function sourceStats(container, source) {
  container[source] ||= {
    searches: 0,
    offers: 0,
    matches: 0,
    errors: 0,
    skipped: 0,
  };
  return container[source];
}

function inclusiveDays(start, end) {
  const first = Date.parse(`${String(start || "")}T00:00:00Z`);
  const last = Date.parse(`${String(end || "")}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) {
    return 0;
  }
  return Math.round((last - first) / 86_400_000) + 1;
}

function appendPriceHistory(previousHistory, offer, searchedAt) {
  const history = Array.isArray(previousHistory)
    ? previousHistory.filter((sample) =>
        Number.isFinite(Number(sample?.totalPrice)) && Number(sample.totalPrice) > 0
      )
    : [];
  const totalPrice = Number(offer.totalPrice);
  if (offer.priceVerified !== true || !Number.isFinite(totalPrice) || totalPrice <= 0) {
    return history.slice(-MAX_PRICE_HISTORY_SAMPLES);
  }
  const sample = {
    at: searchedAt,
    totalPrice,
    nightlyPrice: Number(offer.nightlyPrice) || 0,
    source: offer.source,
    provider: offer.provider || "",
  };
  const previous = history.at(-1);
  const duplicated = previous &&
    previous.at === sample.at &&
    Number(previous.totalPrice) === sample.totalPrice &&
    Number(previous.nightlyPrice) === sample.nightlyPrice &&
    String(previous.source || "") === String(sample.source || "") &&
    String(previous.provider || "") === String(sample.provider || "");
  return (duplicated ? history : [...history, sample]).slice(
    -MAX_PRICE_HISTORY_SAMPLES,
  );
}

function buildPriceProof(offer, searchedAt) {
  if (offer.priceVerified !== true) return null;
  return {
    verifiedAt: offer.priceConfirmedAt || searchedAt,
    source: offer.source,
    provider: offer.provider || "",
    priceBasis: offer.priceBasis || "",
    priceEvidence: offer.priceEvidence || "",
    totalPrice: Number(offer.totalPrice) || 0,
    nightlyPrice: Number(offer.nightlyPrice) || 0,
    confirmationCount: Number(offer.priceConfirmationCount) || 0,
    taxesText: offer.taxesText || "",
  };
}

function advanceDateSweep(shape, cursor, completedSearches, startDate, now) {
  let nextIndex = cursor;
  let nextStartDate = startDate;
  let completedSweep = false;
  if (shape && completedSearches > 0) {
    nextIndex = cursor + completedSearches;
    if (nextIndex >= shape.combinations) {
      nextIndex = 0;
      nextStartDate = now.toISOString().slice(0, 10);
      completedSweep = true;
    }
  }
  return { nextIndex, nextStartDate, completedSweep };
}

function dateCoverageStatus(
  monitor,
  shape,
  cursor,
  completedSearches,
  startDate,
  now,
) {
  const advanced = advanceDateSweep(
    shape,
    cursor,
    completedSearches,
    startDate,
    now,
  );
  return {
    mode: monitor.dateMode,
    sweepStartDate: startDate,
    totalCombinations: shape.exactCombinations,
    totalSearches: shape.combinations,
    startIndex: cursor,
    searchesCheckedThisRun: completedSearches,
    nextIndex: advanced.nextIndex,
    remainingSearchesInSweep: advanced.completedSweep
      ? 0
      : shape.combinations - advanced.nextIndex,
    completedSweep: advanced.completedSweep,
    nextSweepStartDate: advanced.nextStartDate,
  };
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readRemoteJson(filePath, options = {}) {
  const repository = options.repository || process.env.GITHUB_REPOSITORY;
  if (!repository) return null;
  const branch = options.branch || process.env.GITHUB_REF_NAME || "main";
  const fetchImpl = options.fetchImpl || fetch;
  try {
    const response = await fetchImpl(
      `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(branch)}/${filePath}?t=${Date.now()}`,
      { signal: AbortSignal.timeout(10_000), cache: "no-store" },
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function newestRepositoryDocument(localDocument, remoteDocument) {
  if (!remoteDocument || typeof remoteDocument !== "object") {
    return localDocument;
  }
  const localTime = Date.parse(localDocument?.updatedAt || "");
  const remoteTime = Date.parse(remoteDocument.updatedAt || "");
  if (!Number.isFinite(localTime) || remoteTime > localTime) {
    return remoteDocument;
  }
  return localDocument;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function updateOfferState(
  previous = {},
  offer,
  searchedAt,
  scanCycle = searchedAt,
) {
  if (
    offer.source === "booking" &&
    !CURRENT_BOOKING_PRICE_BASES.has(previous.priceBasis)
  ) {
    previous = {};
  }
  const confirmationCount = offer.matches
    ? Number(offer.priceConfirmationCount) || 0
    : 0;
  const previousPublishedPrice =
    Number(previous.publishedPrice) ||
    (previous.matches ? Number(previous.totalPrice) : 0);
  const priceHistory = appendPriceHistory(
    previous.priceHistory,
    offer,
    searchedAt,
  );
  return {
    source: offer.source,
    provider: offer.provider,
    hotelName: offer.hotelName,
    totalPrice: offer.totalPrice,
    nightlyPrice: offer.nightlyPrice,
    matches: offer.matches,
    priceVerified: offer.priceVerified,
    priceBasis: offer.priceBasis,
    priceEvidence: offer.priceEvidence,
    priceProof: buildPriceProof(offer, searchedAt),
    priceHistory,
    searchArea: offer.searchArea,
    checkIn: offer.checkIn,
    checkOut: offer.checkOut,
    confirmationCount,
    publishedPrice: offer.matches ? previousPublishedPrice : 0,
    lastObservationCycle: scanCycle,
    firstSeenAt: previous.firstSeenAt || searchedAt,
    lastSeenAt: searchedAt,
  };
}

function offerStateIsConfirmed(offerState) {
  return (
    offerState.matches === true &&
    offerState.priceVerified === true &&
    Number(offerState.confirmationCount) >= REQUIRED_PRICE_CONFIRMATIONS
  );
}

function resetUnobservedFixedOffers(
  offers,
  monitorId,
  observedOfferKeys,
  source,
) {
  for (const [offerKey, offerState] of Object.entries(offers)) {
    const offerSource = offerState.source || "booking";
    if (
      offerKey.startsWith(`${monitorId}:`) &&
      offerSource === source &&
      !observedOfferKeys.has(offerKey)
    ) {
      offers[offerKey] = {
        ...offerState,
        matches: false,
        confirmationCount: 0,
        publishedPrice: 0,
      };
    }
  }
}

function monitorFingerprint(monitor) {
  const fields = [
    "location",
    "locationId",
    "latitude",
    "longitude",
    "countryCode",
    "locationType",
    "locationCity",
    "locationRadiusKm",
    "dateMode",
    "dateStart",
    "dateEnd",
    "windowDays",
    "minNights",
    "maxNights",
    "maxTotal",
    "maxNightly",
    "priceMatch",
    "priceSafetyPercent",
    "minStars",
    "guestRatingMin",
    "maxDistanceKm",
    "freeCancellation",
    "mealPlan",
    "propertyTypes",
    "amenities",
    "adults",
    "children",
    "rooms",
    "sources",
    "strictPrices",
  ];
  const normalized = Object.fromEntries(
    fields.map((field) => [field, monitor[field] ?? null]),
  );
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 20);
}

function buildDealMap(previousDeals, activeMonitors) {
  const monitorsById = new Map(
    activeMonitors.map((monitor) => [String(monitor.id), monitor]),
  );
  return new Map(
    (previousDeals.deals || [])
      .filter((deal) => {
        const monitor = monitorsById.get(String(deal.monitorId));
        const source = String(deal.source || "booking");
        const strictPriceAllowed =
          monitor?.strictPrices === false || STRICT_PRICE_SOURCES.has(source);
        const hasCurrentBluepillowValidation =
          !BLUEPILLOW_SOURCES.has(source) || Boolean(deal.priceConfirmedAt);
        const hasCurrentBookingValidation =
          source !== "booking" ||
          CURRENT_BOOKING_PRICE_BASES.has(deal.priceBasis);
        const hasCurrentGoogleValidation =
          source !== "google_hotels" ||
          CURRENT_GOOGLE_PRICE_BASES.has(deal.priceBasis);
        const hasCurrentTripValidation =
          source !== "trip" ||
          deal.priceBasis === "trip_direct_final_total_v1";
        return Boolean(
          monitor &&
          deal.monitorFingerprint === monitorFingerprint(monitor) &&
          strictPriceAllowed &&
          hasCurrentBookingValidation &&
          hasCurrentBluepillowValidation &&
          hasCurrentGoogleValidation &&
          hasCurrentTripValidation
        );
      })
      .map((deal) => [deal.id, deal]),
  );
}

function clearSearchedDeals(
  dealMap,
  monitorId,
  dates,
  searchArea = null,
  source = null,
) {
  for (const [dealId, deal] of dealMap) {
    const dealArea = deal.searchArea || deal.location;
    const datesMatch = dates.flexibleCheckInStart
      ? deal.checkIn >= dates.flexibleCheckInStart &&
        deal.checkIn <= dates.flexibleCheckInEnd &&
        Number(deal.nights) === Number(dates.nights)
      : deal.checkIn === dates.checkIn &&
        deal.checkOut === dates.checkOut;
    if (
      String(deal.monitorId) === String(monitorId) &&
      datesMatch &&
      (!searchArea || String(dealArea) === String(searchArea)) &&
      (!source || String(deal.source || "booking") === String(source))
    ) {
      dealMap.delete(dealId);
    }
  }
}

function mergeDeal(previousDeals, monitor, offer, searchedAt, fingerprint) {
  const dealId = `${monitor.id}:${offer.id}`;
  const previous = previousDeals.get(dealId);
  previousDeals.set(dealId, {
    id: dealId,
    monitorId: monitor.id,
    monitorName: monitor.name,
    monitorFingerprint: fingerprint || monitorFingerprint(monitor),
    hotelName: offer.hotelName,
    location: monitor.location,
    searchArea: offer.searchArea || monitor.location,
    address: offer.address,
    checkIn: offer.checkIn,
    checkOut: offer.checkOut,
    nights: offer.nights,
    totalPrice: offer.totalPrice,
    nightlyPrice: offer.nightlyPrice,
    displayedNightlyPrice: offer.displayedNightlyPrice,
    rateSubtotal: offer.rateSubtotal,
    searchResultPrice: offer.searchResultPrice,
    bookingTableTotal: offer.bookingTableTotal,
    bookingTablePriceConsistent: offer.bookingTablePriceConsistent,
    encodedStayTotal: offer.encodedStayTotal,
    bookingPriceSource: offer.bookingPriceSource,
    excludedTaxRate: offer.excludedTaxRate,
    excludedFixedCharges: offer.excludedFixedCharges,
    taxBreakdownText: offer.taxBreakdownText,
    taxFallbackRate: offer.taxFallbackRate,
    additionalCharges: offer.additionalCharges,
    includedTaxesAndFees: offer.includedTaxesAndFees,
    taxesText: offer.taxesText,
    stayText: offer.stayText,
    priceVerified: offer.priceVerified,
    priceBasis: offer.priceBasis,
    priceEvidence: offer.priceEvidence,
    priceProof: offer.priceProof,
    priceHistory: offer.priceHistory,
    priceConfirmedAt: offer.priceConfirmedAt,
    stars: offer.stars,
    guestRating: offer.guestRating,
    reviewCount: offer.reviewCount,
    distanceKm: offer.distanceKm,
    priceConfirmationCount: offer.priceConfirmationCount,
    freeCancellation: offer.freeCancellation,
    breakfastIncluded: offer.breakfastIncluded,
    limitedAvailability: offer.limitedAvailability,
    mealPlan: offer.mealPlan,
    propertyType: offer.propertyType,
    amenities: offer.amenities,
    roomName: offer.roomName,
    sharedRoom: offer.sharedRoom,
    imageUrl: offer.imageUrl,
    firstObservedPrice: offer.firstObservedPrice,
    priceChangedDuringConfirmation: offer.priceChangedDuringConfirmation,
    marketMedianNightly: offer.marketMedianNightly,
    marketSampleSize: offer.marketSampleSize,
    discountPercent: offer.discountPercent,
    errorFareScore: offer.errorFareScore,
    errorFareLevel: offer.errorFareLevel,
    priceDropPercent: offer.priceDropPercent,
    source: offer.source,
    provider: offer.provider,
    url: offer.url,
    firstSeenAt: previous?.firstSeenAt || searchedAt,
    updatedAt: searchedAt,
  });
}

async function runRepositoryScan(options = {}) {
  const clock = options.clock || Date.now;
  const scanStartedAt = clock();
  const configuredBudget = Number(
    options.scanBudgetMs ??
      process.env.RADAR_SCAN_BUDGET_MS ??
      DEFAULT_SCAN_BUDGET_MS,
  );
  const scanBudgetMs = Number.isFinite(configuredBudget) && configuredBudget > 0
    ? configuredBudget
    : Infinity;
  const configuredRequestReserve = Number(
    options.requestReserveMs ??
      process.env.RADAR_REQUEST_RESERVE_MS ??
      DEFAULT_REQUEST_RESERVE_MS,
  );
  const requestReserveMs = Number.isFinite(configuredRequestReserve) &&
      configuredRequestReserve >= 0
    ? configuredRequestReserve
    : DEFAULT_REQUEST_RESERVE_MS;
  const configuredSourceTimeout = Number(
    options.sourceTimeoutMs ??
      process.env.RADAR_SOURCE_TIMEOUT_MS ??
      DEFAULT_SOURCE_TIMEOUT_MS,
  );
  const sourceTimeoutMs = Number.isFinite(configuredSourceTimeout) &&
      configuredSourceTimeout > 0
    ? configuredSourceTimeout
    : DEFAULT_SOURCE_TIMEOUT_MS;
  const deadline = scanStartedAt + scanBudgetMs;
  const timeBudgetReached = () =>
    Number.isFinite(deadline) && clock() + requestReserveMs >= deadline;
  const root = path.resolve(options.root || process.cwd());
  const configPath = path.resolve(
    root,
    options.configPath || "config/searches.json",
  );
  const statePath = path.resolve(
    root,
    options.statePath || "state/repository-state.json",
  );
  const dealsPath = path.resolve(
    root,
    options.dealsPath || "docs/data/deals.json",
  );
  const statusPath = path.resolve(
    root,
    options.statusPath || "docs/data/status.json",
  );
  const localConfig = readJson(configPath, { monitors: [] });
  const localPreviousState = readJson(statePath, {
    version: 1,
    monitors: {},
  });
  const localPreviousDeals = readJson(dealsPath, { deals: [] });
  const remoteDocuments = options.remoteDocuments || (
    process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REPOSITORY
      ? await Promise.all([
          readRemoteJson("config/searches.json", options.remoteOptions),
          readRemoteJson("state/repository-state.json", options.remoteOptions),
          readRemoteJson("docs/data/deals.json", options.remoteOptions),
        ])
      : []
  );
  const config = newestRepositoryDocument(
    localConfig,
    remoteDocuments[0],
  );
  const previousState = newestRepositoryDocument(
    localPreviousState,
    remoteDocuments[1],
  );
  const previousDeals = newestRepositoryDocument(
    localPreviousDeals,
    remoteDocuments[2],
  );
  const now = options.now || new Date();
  const previousCompletedAt =
    previousState.health?.lastCompletedAt || previousState.updatedAt || "";
  const previousCompletedTime = Date.parse(previousCompletedAt);
  const cycleGapMinutes = Number.isFinite(previousCompletedTime)
    ? Math.max(0, Math.round((now.getTime() - previousCompletedTime) / 60_000))
    : null;
  const runtimeScrapers = {
    ...AUTOMATIC_SCRAPERS,
    ...(options.scrapers || {}),
  };
  const activeMonitors = (config.monitors || [])
    .filter((monitor) => monitor.active)
    .filter((monitor) =>
      (monitor.sources || ["booking"]).some(
        (source) => sourceIsEnabledForMonitor(monitor, source),
      ),
    );
  const monitors = activeMonitors
    .filter((monitor) =>
      monitorIsDue(
        {
          ...monitor,
          lastScanAt: previousState.monitors?.[monitor.id]?.lastScanAt,
        },
        now,
      ),
    )
    .slice(0, 10);
  const nextState = {
    version: 1,
    updatedAt: now.toISOString(),
    monitors: { ...(previousState.monitors || {}) },
    telegram: { ...(previousState.telegram || {}) },
  };
  const dealMap = buildDealMap(previousDeals, activeMonitors);
  const monitorStatus = {};
  const alerts = [];
  const currentMatchingOffers = new Set();
  const currentMatchingOffersBySource = new Map();
  const summary = {
    generatedAt: now.toISOString(),
    monitors: monitors.length,
    searches: 0,
    offers: 0,
    matches: 0,
    newMatches: 0,
    priceDrops: 0,
    sources: {},
    verificationErrors: [],
    nearbyErrors: [],
    errors: [],
    timeBudgetReached: false,
    stoppedEarlyMonitors: 0,
  };

  await Promise.all(monitors.map(async (monitor) => {
    const fingerprint = monitorFingerprint(monitor);
    const storedMonitor = nextState.monitors[monitor.id] || { offers: {} };
    const beforeMonitor = storedMonitor.fingerprint === fingerprint
      ? storedMonitor
      : { offers: {} };
    const requestedDateSweepShape = monitor.dateMode === "flexible"
      ? flexibleSearchShape(monitor)
      : monitor.dateMode === "range"
        ? rangeSearchShape(monitor)
        : null;
    const dateSweepShape = requestedDateSweepShape?.combinations
      ? requestedDateSweepShape
      : null;
    const dateSweepStateIsCurrent =
      dateSweepShape &&
      beforeMonitor.dateSweepVersion === DATE_SWEEP_VERSION &&
      beforeMonitor.dateSweepMode === monitor.dateMode;
    const legacyDateSweepCursor = dateSweepStateIsCurrent
      ? Math.max(0, Number(beforeMonitor.dateSweepCursor) || 0)
      : 0;
    const storedSweepCursors = dateSweepStateIsCurrent
      ? beforeMonitor.sourceDateSweepCursors || {}
      : {};
    const storedSweepStartDates = dateSweepStateIsCurrent
      ? beforeMonitor.sourceDateSweepStartDates || {}
      : {};
    const today = now.toISOString().slice(0, 10);
    const sweepStateFor = (key) => ({
      cursor: dateSweepShape
        ? Math.max(
            0,
            Number(storedSweepCursors[key] ?? legacyDateSweepCursor) || 0,
          ) % dateSweepShape.combinations
        : 0,
      startDate: dateSweepShape
        ? String(
            storedSweepStartDates[key] ||
              beforeMonitor.dateSweepStartDate ||
              today,
          )
        : "",
    });
    const sourceSweepStates = {
      discovery: sweepStateFor("discovery"),
      booking: sweepStateFor("booking"),
      google_hotels: sweepStateFor("google_hotels"),
    };
    const nextOffers = { ...(beforeMonitor.offers || {}) };
    const monitorMatchingOffers = new Set();
    const monitorMatchingOffersBySource = new Map();
    const observedOfferKeys = new Set();
    const pendingAlerts = new Map();
    let sourceHealth = { ...(beforeMonitor.sourceHealth || {}) };
    const status = {
      monitorId: monitor.id,
      monitorName: monitor.name,
      lastScanAt: now.toISOString(),
      lastSuccessAt: beforeMonitor.lastSuccessAt || null,
      searches: 0,
      offers: 0,
      matches: 0,
      nearbyLocations: [],
      sources: {},
      error: "",
    };

    let nearbyLocations = Array.isArray(beforeMonitor.nearbyLocations)
      ? beforeMonitor.nearbyLocations
      : null;
    let nearbyDiscoveryFailed = false;
    if (Number(monitor.maxDistanceKm) <= 0) {
      nearbyLocations = [];
    } else if (!nearbyLocations) {
      try {
        nearbyLocations = await discoverNearbyLocations(monitor);
      } catch (error) {
        nearbyLocations = [];
        nearbyDiscoveryFailed = true;
        summary.nearbyErrors.push({
          monitorId: monitor.id,
          monitorName: monitor.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    status.nearbyLocations = nearbyLocations.map((location) => location.name);

    const buildSweepRequests = (key) => buildMonitorScanRequests(
      monitor,
      nearbyLocations,
      now,
      dateSweepShape
        ? {
            startIndex: sourceSweepStates[key].cursor,
            anchorDate: sourceSweepStates[key].startDate,
          }
        : {},
    );
    const scanRequests = buildSweepRequests("discovery");
    const sourceScanRequests = {
      discovery: scanRequests,
      booking: buildSweepRequests("booking"),
      google_hotels: buildSweepRequests("google_hotels"),
    };
    const selectedSources = (monitor.sources || ["booking"])
      .filter((source) => sourceIsEnabledForMonitor(monitor, source));
    const successfulSearches = new Map(
      selectedSources.map((source) => [source, 0]),
    );
    const directSearches = new Map(
      Object.keys(DIRECT_SEARCH_LIMITS).map((source) => [source, 0]),
    );
    for (const source of selectedSources) {
      sourceStats(summary.sources, source);
      sourceStats(status.sources, source);
      currentMatchingOffersBySource.set(
        source,
        currentMatchingOffersBySource.get(source) || new Set(),
      );
      monitorMatchingOffersBySource.set(source, new Set());
    }

    const skipSource = (source, reason, retryAt = "") => {
      const monitorSource = sourceStats(status.sources, source);
      sourceStats(summary.sources, source).skipped += 1;
      monitorSource.skipped += 1;
      monitorSource.lastSkipReason = reason;
      if (retryAt) monitorSource.retryAt = retryAt;
      return { source, skipped: true, skipReason: reason };
    };

    const runSource = async (source, sourceDates, area) => {
      const availability = sourceCanRun(sourceHealth, source, now);
      if (!availability.run) {
        return skipSource(source, availability.reason, availability.retryAt);
      }
      const searchInput = monitorToSearch(monitor, sourceDates, area);
      const summarySource = sourceStats(summary.sources, source);
      const monitorSource = sourceStats(status.sources, source);
      summary.searches += 1;
      status.searches += 1;
      summarySource.searches += 1;
      monitorSource.searches += 1;
      try {
        const result = await runtimeScrapers[source](searchInput, {
          headless: options.headless !== false,
          ...(sourceTimeoutMs ? { timeoutMs: sourceTimeoutMs } : {}),
        });
        sourceHealth = recordSourceSuccess(sourceHealth, source, now);
        if (source === "booking") {
          monitorSource.coveredCheckIns =
            Number(monitorSource.coveredCheckIns || 0) +
            inclusiveDays(
              result.search?.flexibleCheckInStart || result.search?.checkIn,
              result.search?.flexibleCheckInEnd || result.search?.checkIn,
            );
        }
        return { source, result, dates: sourceDates, searchInput };
      } catch (error) {
        sourceHealth = recordSourceFailure(sourceHealth, source, error, now);
        return { source, error, dates: sourceDates, searchInput };
      }
    };

    const completedSweepSearches = {
      discovery: 0,
      booking: 0,
      google_hotels: 0,
    };
    const sweepBlocked = {
      discovery: false,
      booking: false,
      google_hotels: false,
    };
    const discoverySources = selectedSources.filter((source) =>
      DISCOVERY_SOURCES.has(source)
    );
    const requestCount = Math.max(
      scanRequests.length,
      sourceScanRequests.booking.length,
      sourceScanRequests.google_hotels.length,
    );
    for (let requestIndex = 0; requestIndex < requestCount; requestIndex += 1) {
      if (timeBudgetReached()) {
        status.stoppedEarly = true;
        status.stopReason = "scan_time_budget";
        summary.timeBudgetReached = true;
        summary.stoppedEarlyMonitors += 1;
        break;
      }
      const discoveryRequest = sourceScanRequests.discovery[requestIndex];
      let discoveryRuns = [];
      if (
        discoveryRequest &&
        discoverySources.length > 0 &&
        !sweepBlocked.discovery
      ) {
        discoveryRuns = await Promise.all(
          discoverySources.map(async (source) => ({
            ...(await runSource(
              source,
              discoveryRequest.dates,
              discoveryRequest.area,
            )),
            sweepKey: "discovery",
          })),
        );
        if (discoveryRuns.some((run) => run.result)) {
          completedSweepSearches.discovery += 1;
        } else {
          sweepBlocked.discovery = true;
        }
      }
      const directRuns = [];

      const bookingRequest = sourceScanRequests.booking[requestIndex];
      if (
        selectedSources.includes("booking") &&
        bookingRequest &&
        !sweepBlocked.booking &&
        directSearches.get("booking") < DIRECT_SEARCH_LIMITS.booking
      ) {
        const bookingRun = {
          ...(await runSource(
            "booking",
            bookingDiscoveryDates(monitor, bookingRequest.dates),
            bookingRequest.area,
          )),
          sweepKey: "booking",
        };
        if (bookingRun.skipped) {
          sweepBlocked.booking = true;
        } else {
          directSearches.set(
            "booking",
            directSearches.get("booking") + 1,
          );
          completedSweepSearches.booking += 1;
        }
        directRuns.push(bookingRun);
      }

      const googleRequest = sourceScanRequests.google_hotels[requestIndex];
      if (
        selectedSources.includes("google_hotels") &&
        googleRequest &&
        !sweepBlocked.google_hotels &&
        directSearches.get("google_hotels") <
          DIRECT_SEARCH_LIMITS.google_hotels
      ) {
        const eligibility = googleDateEligibility(
          googleRequest.dates.checkIn,
          now,
        );
        if (!eligibility.eligible) {
          directRuns.push(
            {
              ...skipSource("google_hotels", eligibility.reason),
              dates: googleRequest.dates,
              searchInput: monitorToSearch(
                monitor,
                googleRequest.dates,
                googleRequest.area,
              ),
              sweepKey: "google_hotels",
            },
          );
          completedSweepSearches.google_hotels += 1;
        } else {
          const googleRun = {
            ...(await runSource(
              "google_hotels",
              googleRequest.dates,
              googleRequest.area,
            )),
            sweepKey: "google_hotels",
          };
          if (googleRun.skipped) {
            sweepBlocked.google_hotels = true;
          } else {
            directSearches.set(
              "google_hotels",
              directSearches.get("google_hotels") + 1,
            );
            completedSweepSearches.google_hotels += 1;
          }
          directRuns.push(googleRun);
        }
      }

      const sourceRuns = [...discoveryRuns, ...directRuns].filter(
        (run) => DIRECT_SOURCES.has(run.source) || DISCOVERY_SOURCES.has(run.source),
      );
      const marketGroups = new Map();
      for (const run of sourceRuns) {
        for (const offer of run.result?.offers || []) {
          const key = `${offer.checkIn || run.dates?.checkIn}|${
            offer.checkOut || run.dates?.checkOut
          }`;
          if (!marketGroups.has(key)) marketGroups.set(key, []);
          marketGroups.get(key).push(offer);
        }
      }
      for (const marketOffers of marketGroups.values()) {
        annotateMarketPrices(marketOffers);
      }
      for (const run of sourceRuns) {
        const { source } = run;
        if (run.skipped) continue;
        if (run.error) {
          const message = run.error instanceof Error
            ? run.error.message
            : String(run.error);
          status.error = `[${source}] ${message}`;
          sourceStats(status.sources, source).errors += 1;
          sourceStats(summary.sources, source).errors += 1;
          summary.errors.push({
            monitorId: monitor.id,
            monitorName: monitor.name,
            source,
            dates: run.dates,
            searchArea: run.searchInput?.searchArea || monitor.location,
            message,
          });
          continue;
        }

        const { result } = run;
        successfulSearches.set(
          source,
          successfulSearches.get(source) + 1,
        );
        status.lastSuccessAt = result.searchedAt;
        status.offers += result.offers.length;
        summary.offers += result.offers.length;
        status.sources[source].offers += result.offers.length;
        summary.sources[source].offers += result.offers.length;
        summary.verificationErrors.push(
          ...(result.verificationErrors || []).map((error) => ({
            monitorId: monitor.id,
            monitorName: monitor.name,
            source,
            dates: run.dates,
            searchArea: run.searchInput?.searchArea || monitor.location,
            ...error,
          })),
        );
        clearSearchedDeals(
          dealMap,
          monitor.id,
          {
            checkIn: result.search?.checkIn || run.dates?.checkIn,
            checkOut:
              result.search?.checkOut || run.dates?.checkOut,
            nights: result.search?.nights || run.dates?.nights,
            flexibleCheckInStart: result.search?.flexibleWindowDays
              ? result.search.flexibleCheckInStart
              : undefined,
            flexibleCheckInEnd: result.search?.flexibleWindowDays
              ? result.search.flexibleCheckInEnd
              : undefined,
          },
          run.searchInput?.searchArea || monitor.location,
          source,
        );

        for (const offer of result.offers) {
          const offerKey = `${monitor.id}:${offer.id}`;
          observedOfferKeys.add(offerKey);
          const before = nextOffers[offerKey];
          const nextOfferState = updateOfferState(
            before,
            offer,
            result.searchedAt,
            now.toISOString(),
          );
          offer.priceHistory = nextOfferState.priceHistory;
          offer.priceProof = nextOfferState.priceProof;
          const confirmed = offerStateIsConfirmed(nextOfferState);
          if (confirmed) {
            const previousPublishedPrice =
              Number(before?.publishedPrice) ||
              (before?.matches ? Number(before.totalPrice) : 0);
            const type = previousPublishedPrice <= 0
              ? "new_match"
              : offer.totalPrice <
                  previousPublishedPrice - PRICE_COMPARISON_EPSILON
                ? "price_drop"
                : "";
            applyPriceDropIntelligence(offer, previousPublishedPrice);
            offer.priceConfirmationCount = nextOfferState.confirmationCount;
            offer.priceConfirmedAt =
              offer.priceConfirmedAt || result.searchedAt;
            offer.priceProof = {
              ...(offer.priceProof || buildPriceProof(offer, result.searchedAt)),
              verifiedAt: offer.priceConfirmedAt,
              confirmationCount: nextOfferState.confirmationCount,
            };
            nextOfferState.publishedPrice = offer.totalPrice;
            monitorMatchingOffers.add(offerKey);
            monitorMatchingOffersBySource.get(source).add(offerKey);
            currentMatchingOffers.add(offerKey);
            currentMatchingOffersBySource.get(source).add(offerKey);
            if (type) {
              pendingAlerts.set(offerKey, {
                type,
                monitorId: monitor.id,
                monitorName: monitor.name,
                previousPrice: previousPublishedPrice,
                offer,
                createdAt: result.searchedAt,
              });
            }
          }
          nextOffers[offerKey] = nextOfferState;
          if (confirmed) {
            mergeDeal(
              dealMap,
              monitor,
              offer,
              result.searchedAt,
              fingerprint,
            );
          } else {
            monitorMatchingOffers.delete(offerKey);
            monitorMatchingOffersBySource.get(source).delete(offerKey);
            currentMatchingOffers.delete(offerKey);
            currentMatchingOffersBySource.get(source).delete(offerKey);
            pendingAlerts.delete(offerKey);
            dealMap.delete(`${monitor.id}:${offer.id}`);
          }
          status.matches = monitorMatchingOffers.size;
          summary.matches = currentMatchingOffers.size;
          status.sources[source].matches =
            monitorMatchingOffersBySource.get(source).size;
          summary.sources[source].matches =
            currentMatchingOffersBySource.get(source).size;
        }
      }
    }

    for (const source of selectedSources) {
      const monitorSource = sourceStats(status.sources, source);
      const healthEntry = sourceHealth[source] || {};
      const availability = sourceCanRun(sourceHealth, source, now);
      monitorSource.state = !availability.run
        ? "paused"
        : Number(monitorSource.searches) === 0 &&
            Number(monitorSource.skipped) > 0
          ? "limited"
          : Number(healthEntry.consecutiveErrors) > 0
            ? "degraded"
            : "healthy";
      monitorSource.consecutiveErrors =
        Number(healthEntry.consecutiveErrors) || 0;
      monitorSource.lastSuccessAt = healthEntry.lastSuccessAt || "";
      monitorSource.lastError = healthEntry.lastError || "";
      monitorSource.retryAt = availability.retryAt || monitorSource.retryAt || "";
    }

    let nextDateSweepCursor = 0;
    let nextDateSweepStartDate = "";
    const nextSourceSweepCursors = {};
    const nextSourceSweepStartDates = {};
    if (dateSweepShape) {
      status.sourceCoverage = {};
      const sweepKeys = ["discovery", "booking", "google_hotels"];
      const coverageByKey = {};
      for (const key of sweepKeys) {
        const sweep = sourceSweepStates[key];
        const coverage = dateCoverageStatus(
          monitor,
          dateSweepShape,
          sweep.cursor,
          completedSweepSearches[key],
          sweep.startDate,
          now,
        );
        coverageByKey[key] = coverage;
        nextSourceSweepCursors[key] = coverage.nextIndex;
        nextSourceSweepStartDates[key] = coverage.nextSweepStartDate;
      }
      for (const source of selectedSources) {
        const key = DISCOVERY_SOURCES.has(source) ? "discovery" : source;
        status.sourceCoverage[source] = coverageByKey[key];
        status.sources[source].dateCoverage = coverageByKey[key];
      }
      const primarySweepKey = discoverySources.length > 0
        ? "discovery"
        : selectedSources.find((source) => DIRECT_SOURCES.has(source)) ||
          "discovery";
      status.dateCoverage = coverageByKey[primarySweepKey];
      nextDateSweepCursor = coverageByKey[primarySweepKey].nextIndex;
      nextDateSweepStartDate =
        coverageByKey[primarySweepKey].nextSweepStartDate;
    }

    if (monitor.dateMode === "fixed") {
      for (const source of selectedSources) {
        if (successfulSearches.get(source) === scanRequests.length) {
          resetUnobservedFixedOffers(
            nextOffers,
            String(monitor.id),
            observedOfferKeys,
            source,
          );
        }
      }
    }

    for (const alert of pendingAlerts.values()) {
      alerts.push(alert);
      if (alert.type === "price_drop") summary.priceDrops += 1;
      else summary.newMatches += 1;
    }

    nextState.monitors[monitor.id] = {
      fingerprint,
      lastScanAt: now.toISOString(),
      lastSuccessAt: status.lastSuccessAt,
      nearbyLocations: nearbyDiscoveryFailed ? null : nearbyLocations,
      sourceHealth,
      ...(dateSweepShape
        ? {
            dateSweepVersion: DATE_SWEEP_VERSION,
            dateSweepMode: monitor.dateMode,
            dateSweepCursor: nextDateSweepCursor,
            dateSweepStartDate: nextDateSweepStartDate,
            sourceDateSweepCursors: nextSourceSweepCursors,
            sourceDateSweepStartDates: nextSourceSweepStartDates,
          }
        : {}),
      offers: nextOffers,
    };
    monitorStatus[monitor.id] = status;
  }));

  const sevenDaysAgo = now.getTime() - 7 * 86_400_000;
  const currentDeals = Array.from(dealMap.values()).filter(
    (deal) => Date.parse(deal.updatedAt) >= sevenDaysAgo,
  );
  const deals = enrichDealComparisons(currentDeals)
    .sort(
      (left, right) =>
        left.totalPrice - right.totalPrice ||
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )
    .slice(0, 300);
  const dealsById = new Map(deals.map((deal) => [deal.id, deal]));
  for (const alert of alerts) {
    const enriched = dealsById.get(`${alert.monitorId}:${alert.offer.id}`);
    if (!enriched) continue;
    Object.assign(alert.offer, {
      comparisonGroupId: enriched.comparisonGroupId,
      providerCount: enriched.providerCount,
      comparisonProviders: enriched.comparisonProviders,
      bestTotalPrice: enriched.bestTotalPrice,
      isBestPrice: enriched.isBestPrice,
      marketMedianNightly: enriched.marketMedianNightly,
      marketSampleSize: enriched.marketSampleSize,
      discountPercent: enriched.discountPercent,
      errorFareScore: enriched.errorFareScore,
      errorFareLevel: enriched.errorFareLevel,
      priceDropPercent: enriched.priceDropPercent,
    });
  }
  const durationMs = Math.max(0, clock() - scanStartedAt);
  const completedNormally = summary.timeBudgetReached !== true;
  const health = {
    state: summary.timeBudgetReached
      ? "partial"
      : summary.errors.length > 0 && summary.searches === summary.errors.length
        ? "degraded"
        : "healthy",
    startedAt: now.toISOString(),
    lastCompletedAt: now.toISOString(),
    previousCompletedAt: previousCompletedAt || null,
    gapMinutes: cycleGapMinutes,
    recoveredAfterInterruption:
      cycleGapMinutes !== null && cycleGapMinutes >= 30,
    durationMs,
    completedNormally,
    monitorsProcessed: monitors.length,
    searchesCompleted: summary.searches,
  };
  summary.durationMs = durationMs;
  summary.health = health;
  nextState.health = health;
  const status = {
    version: 1,
    updatedAt: now.toISOString(),
    summary,
    health,
    monitors: monitorStatus,
    alerts: alerts.slice(0, 100),
  };

  writeJson(statePath, nextState);
  writeJson(dealsPath, {
    version: 1,
    updatedAt: now.toISOString(),
    deals,
  });
  writeJson(statusPath, status);

  return { summary, deals, status };
}

if (require.main === module) {
  runRepositoryScan({ headless: false })
    .then(({ summary }) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (summary.searches > 0 && summary.errors.length === summary.searches) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

module.exports = {
  appendPriceHistory,
  buildPriceProof,
  buildDealMap,
  clearSearchedDeals,
  inclusiveDays,
  mergeDeal,
  monitorFingerprint,
  newestRepositoryDocument,
  offerStateIsConfirmed,
  priceWithinDiscoveryRange,
  readJson,
  readRemoteJson,
  resultHasPromisingCandidate,
  runRepositoryScan,
  sourceIsEnabledForMonitor,
  updateOfferState,
  writeJson,
};
