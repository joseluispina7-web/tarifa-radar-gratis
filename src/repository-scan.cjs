const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { scrapeBooking } = require("./booking-scraper.cjs");
const { discoverNearbyLocations } = require("./nearby-locations.cjs");
const {
  buildMonitorScanRequests,
  monitorIsDue,
  monitorToSearch,
} = require("./remote-scan.cjs");

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

function updateOfferState(previous = {}, offer, searchedAt) {
  return {
    hotelName: offer.hotelName,
    totalPrice: offer.totalPrice,
    nightlyPrice: offer.nightlyPrice,
    matches: offer.matches,
    priceVerified: offer.priceVerified,
    priceBasis: offer.priceBasis,
    firstSeenAt: previous.firstSeenAt || searchedAt,
    lastSeenAt: searchedAt,
  };
}

function monitorFingerprint(monitor) {
  const fields = [
    "location",
    "locationId",
    "latitude",
    "longitude",
    "countryCode",
    "dateMode",
    "dateStart",
    "dateEnd",
    "windowDays",
    "minNights",
    "maxNights",
    "maxTotal",
    "maxNightly",
    "priceMatch",
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
        return Boolean(
          monitor &&
          deal.monitorFingerprint === monitorFingerprint(monitor)
        );
      })
      .map((deal) => [deal.id, deal]),
  );
}

function clearSearchedDeals(dealMap, monitorId, dates, searchArea = null) {
  for (const [dealId, deal] of dealMap) {
    const dealArea = deal.searchArea || deal.location;
    if (
      String(deal.monitorId) === String(monitorId) &&
      deal.checkIn === dates.checkIn &&
      deal.checkOut === dates.checkOut &&
      (!searchArea || String(dealArea) === String(searchArea))
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
    rateSubtotal: offer.rateSubtotal,
    searchResultPrice: offer.searchResultPrice,
    bookingTableTotal: offer.bookingTableTotal,
    taxFallbackRate: offer.taxFallbackRate,
    additionalCharges: offer.additionalCharges,
    taxesText: offer.taxesText,
    stayText: offer.stayText,
    priceVerified: offer.priceVerified,
    priceBasis: offer.priceBasis,
    stars: offer.stars,
    guestRating: offer.guestRating,
    reviewCount: offer.reviewCount,
    distanceKm: offer.distanceKm,
    freeCancellation: offer.freeCancellation,
    mealPlan: offer.mealPlan,
    propertyType: offer.propertyType,
    amenities: offer.amenities,
    source: offer.source,
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
    .filter((monitor) => monitor.sources?.includes("booking"));
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
  const summary = {
    generatedAt: now.toISOString(),
    monitors: monitors.length,
    searches: 0,
    offers: 0,
    matches: 0,
    newMatches: 0,
    priceDrops: 0,
    verificationErrors: [],
    nearbyErrors: [],
    errors: [],
  };

  for (const monitor of monitors) {
    const fingerprint = monitorFingerprint(monitor);
    const storedMonitor = nextState.monitors[monitor.id] || { offers: {} };
    const beforeMonitor = storedMonitor.fingerprint === fingerprint
      ? storedMonitor
      : { offers: {} };
    const nextOffers = { ...(beforeMonitor.offers || {}) };
    const status = {
      monitorId: monitor.id,
      monitorName: monitor.name,
      lastScanAt: now.toISOString(),
      lastSuccessAt: beforeMonitor.lastSuccessAt || null,
      searches: 0,
      offers: 0,
      matches: 0,
      nearbyLocations: [],
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

    for (const request of buildMonitorScanRequests(
      monitor,
      nearbyLocations,
      now,
    )) {
      const { dates, area } = request;
      summary.searches += 1;
      status.searches += 1;
      try {
        const result = await scrapeBooking(
          monitorToSearch(monitor, dates, area),
          { headless: options.headless !== false },
        );
        status.lastSuccessAt = result.searchedAt;
        status.offers += result.offers.length;
        status.matches += result.matchingOffers.length;
        summary.offers += result.offers.length;
        summary.matches += result.matchingOffers.length;
        summary.verificationErrors.push(
          ...(result.verificationErrors || []).map((error) => ({
            monitorId: monitor.id,
            monitorName: monitor.name,
            dates,
            searchArea: area.name,
            ...error,
          })),
        );
        clearSearchedDeals(dealMap, monitor.id, dates, area.name);

        for (const offer of result.offers) {
          const offerKey = `${monitor.id}:${offer.id}`;
          const before = nextOffers[offerKey];
          if (
            offer.matches &&
            (!before || !before.matches || offer.totalPrice < before.totalPrice)
          ) {
            const type = before ? "price_drop" : "new_match";
            alerts.push({
              type,
              monitorId: monitor.id,
              monitorName: monitor.name,
              previousPrice: before?.totalPrice || 0,
              offer,
              createdAt: result.searchedAt,
            });
            if (type === "price_drop") summary.priceDrops += 1;
            else summary.newMatches += 1;
          }
          nextOffers[offerKey] = updateOfferState(
            before,
            offer,
            result.searchedAt,
          );
          if (offer.matches) {
            mergeDeal(
              dealMap,
              monitor,
              offer,
              result.searchedAt,
              fingerprint,
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.error = message;
        summary.errors.push({
          monitorId: monitor.id,
          monitorName: monitor.name,
          dates,
          searchArea: area.name,
          message,
        });
      }
    }

    nextState.monitors[monitor.id] = {
      fingerprint,
      lastScanAt: now.toISOString(),
      lastSuccessAt: status.lastSuccessAt,
      nearbyLocations: nearbyDiscoveryFailed ? null : nearbyLocations,
      offers: nextOffers,
    };
    monitorStatus[monitor.id] = status;
  }

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
  readJson,
  runRepositoryScan,
  updateOfferState,
  writeJson,
};
