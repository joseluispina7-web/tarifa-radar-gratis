const { scrapeBooking } = require("./booking-scraper.cjs");

const FIVE_MINUTES_MS = 5 * 60_000;
const FLEXIBLE_SEARCHES_PER_RUN = 2;
const FIXED_NEARBY_AREAS_PER_RUN = 3;

function parseTimestamp(value) {
  if (!value) return 0;
  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(value)
    ? value
    : `${String(value).replace(" ", "T")}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function monitorIsDue(monitor, now = new Date()) {
  const intervalMs = Math.max(5, Number(monitor.intervalMinutes) || 5) * 60_000;
  const lastScan = parseTimestamp(monitor.lastScanAt);
  return !lastScan || now.getTime() - lastScan >= intervalMs - 30_000;
}

function addUtcDays(date, days) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function monitorSeed(value) {
  return String(value || "")
    .split("")
    .reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 10007, 0);
}

function buildMonitorSearches(monitor, now = new Date()) {
  if (monitor.dateMode === "fixed") {
    return [{ checkIn: monitor.dateStart, checkOut: monitor.dateEnd }];
  }

  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const windowDays = Math.max(30, Math.min(365, Number(monitor.windowDays) || 180));
  const minNights = Math.max(1, Number(monitor.minNights) || 4);
  const maxNights = Math.max(
    minNights,
    Math.min(minNights + 13, Number(monitor.maxNights) || minNights),
  );
  const stayOptions = maxNights - minNights + 1;
  const combinations = windowDays * stayOptions;
  const slot = Math.floor(now.getTime() / FIVE_MINUTES_MS);

  return Array.from({ length: FLEXIBLE_SEARCHES_PER_RUN }, (_, offset) => {
    const index =
      (slot * FLEXIBLE_SEARCHES_PER_RUN +
        monitorSeed(monitor.id) * 29 +
        offset) %
      combinations;
    const dayOffset = Math.floor(index / stayOptions) + 1;
    const nights = minNights + (index % stayOptions);
    const checkInDate = addUtcDays(today, dayOffset);
    return {
      checkIn: isoDay(checkInDate),
      checkOut: isoDay(addUtcDays(checkInDate, nights)),
    };
  });
}

function buildMonitorScanRequests(
  monitor,
  nearbyLocations = [],
  now = new Date(),
) {
  const dates = buildMonitorSearches(monitor, now);
  const mainArea = {
    name: monitor.location,
    query: monitor.location,
    isNearby: false,
  };
  const nearbyAreas = (nearbyLocations || []).map((location) => ({
    name: location.name,
    query: location.query || location.name,
    isNearby: true,
  }));
  if (!nearbyAreas.length) {
    return dates.map((stay) => ({ dates: stay, area: mainArea }));
  }

  const slot = Math.floor(now.getTime() / FIVE_MINUTES_MS);
  const startIndex = (slot + monitorSeed(monitor.id)) % nearbyAreas.length;
  if (monitor.dateMode === "fixed") {
    const selectedNearbyAreas = Array.from(
      {
        length: Math.min(
          FIXED_NEARBY_AREAS_PER_RUN,
          nearbyAreas.length,
        ),
      },
      (_, index) => nearbyAreas[(startIndex + index) % nearbyAreas.length],
    );
    return [
      { dates: dates[0], area: mainArea },
      ...selectedNearbyAreas.map((area) => ({ dates: dates[0], area })),
    ];
  }

  const areas = [mainArea, ...nearbyAreas];
  return dates.map((stay, index) => ({
    dates: stay,
    area: areas[(slot + monitorSeed(monitor.id) + index) % areas.length],
  }));
}

function monitorToSearch(monitor, dates, area = null) {
  const destination = area?.query || monitor.location;
  return {
    id: `${monitor.id}-${dates.checkIn}-${dates.checkOut}`,
    name: monitor.name,
    destination: {
      query: destination,
      label: area?.name || monitor.location,
      countryCode: monitor.countryCode,
    },
    searchArea: area?.name || monitor.location,
    isNearbySearch: area?.isNearby === true,
    originLatitude: monitor.latitude,
    originLongitude: monitor.longitude,
    countryCode: monitor.countryCode,
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    adults: monitor.adults,
    children: monitor.children,
    rooms: monitor.rooms,
    maxTotal: monitor.maxTotal,
    maxNightly: monitor.maxNightly,
    priceRule: monitor.priceMatch === "both" ? "and" : "or",
    minStars: monitor.minStars,
    guestRatingMin: monitor.guestRatingMin,
    maxDistanceKm: Number(monitor.maxDistanceKm) || 0,
    freeCancellation: monitor.freeCancellation,
    mealPlan: monitor.mealPlan,
    propertyTypes: monitor.propertyTypes,
    amenities: monitor.amenities,
    excludeSharedRooms: true,
    maxResults: Number(monitor.maxDistanceKm) > 0 ? 25 : 30,
  };
}

async function panelRequest(panelUrl, ingestToken, pathname, options = {}) {
  const response = await fetch(`${panelUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${ingestToken}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `El panel respondió ${response.status}.`);
  }
  return payload;
}

async function sendOffer(panelUrl, ingestToken, monitor, offer) {
  return panelRequest(panelUrl, ingestToken, "/api/ingest", {
    method: "POST",
    body: JSON.stringify({
      monitorId: monitor.id,
      externalId: offer.id,
      hotelName: offer.hotelName,
      location: monitor.location,
      checkIn: offer.checkIn,
      checkOut: offer.checkOut,
      nights: offer.nights,
      totalPrice: offer.totalPrice,
      nightlyPrice: offer.nightlyPrice,
      stars: offer.stars,
      guestRating: offer.guestRating,
      distanceKm: offer.distanceKm,
      freeCancellation: offer.freeCancellation,
      mealPlan: offer.mealPlan,
      propertyType: offer.propertyType,
      amenities: offer.amenities,
      source: offer.source,
      url: offer.url,
    }),
  });
}

async function runRemoteScan(options = {}) {
  const panelUrl = String(options.panelUrl || process.env.PANEL_URL || "")
    .replace(/\/+$/, "");
  const ingestToken = String(
    options.ingestToken || process.env.INGEST_TOKEN || "",
  );
  if (!panelUrl || !ingestToken) {
    throw new Error("Faltan PANEL_URL o INGEST_TOKEN.");
  }

  const now = options.now || new Date();
  const payload = await panelRequest(
    panelUrl,
    ingestToken,
    "/api/scanner/monitors",
  );
  const monitors = (payload.monitors || [])
    .filter((monitor) => monitor.active)
    .filter((monitor) => monitor.sources?.includes("booking"))
    .filter((monitor) => monitorIsDue(monitor, now))
    .slice(0, 10);
  const summary = {
    generatedAt: now.toISOString(),
    monitors: monitors.length,
    searches: 0,
    offers: 0,
    accepted: 0,
    errors: [],
  };

  for (const monitor of monitors) {
    let successfulSearches = 0;
    for (const dates of buildMonitorSearches(monitor, now)) {
      summary.searches += 1;
      try {
        const result = await scrapeBooking(monitorToSearch(monitor, dates), {
          headless: options.headless !== false,
        });
        successfulSearches += 1;
        summary.offers += result.matchingOffers.length;
        for (const offer of result.matchingOffers) {
          const ingested = await sendOffer(
            panelUrl,
            ingestToken,
            monitor,
            offer,
          );
          if (ingested.accepted) summary.accepted += 1;
        }
      } catch (error) {
        summary.errors.push({
          monitorId: monitor.id,
          dates,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (successfulSearches > 0) {
      await panelRequest(panelUrl, ingestToken, "/api/scanner/report", {
        method: "POST",
        body: JSON.stringify({ monitorId: monitor.id }),
      });
    }
  }

  return summary;
}

if (require.main === module) {
  runRemoteScan({ headless: false })
    .then((summary) => {
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
  buildMonitorScanRequests,
  buildMonitorSearches,
  monitorIsDue,
  monitorToSearch,
  parseTimestamp,
  runRemoteScan,
};
