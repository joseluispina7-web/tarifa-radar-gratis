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
  buildMonitorScanRequests,
  flexibleSearchShape,
  monitorIsDue,
  monitorToSearch,
  rangeSearchShape,
} = require("./remote-scan.cjs");

const REQUIRED_PRICE_CONFIRMATIONS = 2;
const PRICE_COMPARISON_EPSILON = 0.01;
const DATE_SWEEP_VERSION = 3;
const BLUEPILLOW_SOURCES = new Set(["agoda", "trip", "bluepillow"]);
const STRICT_PRICE_SOURCES = new Set(["booking", "google_hotels", "trip"]);
const CURRENT_BOOKING_PRICE_BASES = new Set([
  "booking_visible_final_total_v5",
]);
const CURRENT_GOOGLE_PRICE_BASES = new Set([
  "google_hotels_provider_all_inclusive_v7",
  "google_hotels_visible_all_inclusive_v7",
]);
const AUTOMATIC_SCRAPERS = {
  booking: scrapeBooking,
  google_hotels: scrapeGoogleHotels,
  agoda: scrapeAgoda,
  trip: scrapeTrip,
  bluepillow: scrapeBluepillow,
};

function sourceIsEnabledForMonitor(monitor, source) {
  return Boolean(
    AUTOMATIC_SCRAPERS[source] &&
      (monitor.strictPrices === false || STRICT_PRICE_SOURCES.has(source)),
  );
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
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
    source: offer.source,
    provider: offer.provider,
    url: offer.url,
    firstSeenAt: previous?.firstSeenAt || searchedAt,
    updatedAt: searchedAt,
  });
}

async function runRepositoryScan(options = {}) {
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
  const config = readJson(configPath, { monitors: [] });
  const previousState = readJson(statePath, {
    version: 1,
    monitors: {},
  });
  const previousDeals = readJson(dealsPath, { deals: [] });
  const now = options.now || new Date();
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
    const dateSweepCursor = dateSweepStateIsCurrent
      ? Math.max(0, Number(beforeMonitor.dateSweepCursor) || 0) %
        dateSweepShape.combinations
      : 0;
    const dateSweepStartDate = dateSweepShape
      ? (dateSweepStateIsCurrent
          ? beforeMonitor.dateSweepStartDate
          : "") ||
        now.toISOString().slice(0, 10)
      : "";
    const nextOffers = { ...(beforeMonitor.offers || {}) };
    const monitorMatchingOffers = new Set();
    const monitorMatchingOffersBySource = new Map();
    const observedOfferKeys = new Set();
    const pendingAlerts = new Map();
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

    const scanRequests = buildMonitorScanRequests(
      monitor,
      nearbyLocations,
      now,
      dateSweepShape
        ? {
            startIndex: dateSweepCursor,
            anchorDate: dateSweepStartDate,
          }
        : {},
    );
    const selectedSources = (monitor.sources || ["booking"])
      .filter((source) => sourceIsEnabledForMonitor(monitor, source));
    const successfulSearches = new Map(
      selectedSources.map((source) => [source, 0]),
    );
    let completedDateSweepRequests = 0;
    for (const request of scanRequests) {
      const { dates, area } = request;
      const searchInput = monitorToSearch(monitor, dates, area);
      const sourceRuns = await Promise.all(
        selectedSources.map(async (source) => {
          summary.searches += 1;
          status.searches += 1;
          summary.sources[source] ||= {
            searches: 0,
            offers: 0,
            matches: 0,
            errors: 0,
          };
          status.sources[source] ||= {
            searches: 0,
            offers: 0,
            matches: 0,
            errors: 0,
          };
          if (!currentMatchingOffersBySource.has(source)) {
            currentMatchingOffersBySource.set(source, new Set());
          }
          if (!monitorMatchingOffersBySource.has(source)) {
            monitorMatchingOffersBySource.set(source, new Set());
          }
          summary.sources[source].searches += 1;
          status.sources[source].searches += 1;
          try {
            const result = await AUTOMATIC_SCRAPERS[source](
              searchInput,
              { headless: options.headless !== false },
            );
            return { source, result };
          } catch (error) {
            return { source, error };
          }
        }),
      );
      let requestSucceeded = false;
      for (const run of sourceRuns) {
        const { source } = run;
        if (run.error) {
          const message = run.error instanceof Error
            ? run.error.message
            : String(run.error);
          status.error = `[${source}] ${message}`;
          status.sources[source].errors += 1;
          summary.sources[source].errors += 1;
          summary.errors.push({
            monitorId: monitor.id,
            monitorName: monitor.name,
            source,
            dates,
            searchArea: area.name,
            message,
          });
          continue;
        }

        requestSucceeded = true;
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
            dates,
            searchArea: area.name,
            ...error,
          })),
        );
        clearSearchedDeals(
          dealMap,
          monitor.id,
          dates,
          area.name,
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
            offer.priceConfirmationCount = nextOfferState.confirmationCount;
            offer.priceConfirmedAt =
              offer.priceConfirmedAt || result.searchedAt;
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
      if (dateSweepShape && requestSucceeded) completedDateSweepRequests += 1;
      if (dateSweepShape && !requestSucceeded) break;
    }

    let nextDateSweepCursor = dateSweepCursor;
    let nextDateSweepStartDate = dateSweepStartDate;
    let completedDateSweep = false;
    if (dateSweepShape && completedDateSweepRequests > 0) {
      nextDateSweepCursor = dateSweepCursor + completedDateSweepRequests;
      if (nextDateSweepCursor >= dateSweepShape.combinations) {
        nextDateSweepCursor = 0;
        nextDateSweepStartDate = now.toISOString().slice(0, 10);
        completedDateSweep = true;
      }
      status.dateCoverage = {
        mode: monitor.dateMode,
        sweepStartDate: dateSweepStartDate,
        totalCombinations: dateSweepShape.exactCombinations,
        totalSearches: dateSweepShape.combinations,
        startIndex: dateSweepCursor,
        searchesCheckedThisRun: completedDateSweepRequests,
        nextIndex: nextDateSweepCursor,
        remainingSearchesInSweep: completedDateSweep
          ? 0
          : dateSweepShape.combinations - nextDateSweepCursor,
        completedSweep: completedDateSweep,
      };
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
      ...(dateSweepShape
        ? {
            dateSweepVersion: DATE_SWEEP_VERSION,
            dateSweepMode: monitor.dateMode,
            dateSweepCursor: nextDateSweepCursor,
            dateSweepStartDate: nextDateSweepStartDate,
          }
        : {}),
      offers: nextOffers,
    };
    monitorStatus[monitor.id] = status;
  }));

  const sevenDaysAgo = now.getTime() - 7 * 86_400_000;
  const deals = Array.from(dealMap.values())
    .filter((deal) => Date.parse(deal.updatedAt) >= sevenDaysAgo)
    .sort(
      (left, right) =>
        left.totalPrice - right.totalPrice ||
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )
    .slice(0, 300);
  const status = {
    version: 1,
    updatedAt: now.toISOString(),
    summary,
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
  buildDealMap,
  clearSearchedDeals,
  mergeDeal,
  monitorFingerprint,
  offerStateIsConfirmed,
  readJson,
  runRepositoryScan,
  sourceIsEnabledForMonitor,
  updateOfferState,
  writeJson,
};
