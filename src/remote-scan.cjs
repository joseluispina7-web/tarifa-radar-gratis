const { scrapeBooking } = require("./booking-scraper.cjs");

const FIVE_MINUTES_MS = 5 * 60_000;
const FLEXIBLE_SEARCHES_PER_RUN = 4;
const FLEXIBLE_WINDOW_DAYS = 7;
const FLEXIBLE_WINDOW_SPAN = FLEXIBLE_WINDOW_DAYS * 2 + 1;
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

function bookingDiscoveryDates(monitor, dates) {
  if (
    monitor.dateMode !== "range" ||
    Number(dates.flexibleWindowDays) > 0
  ) {
    return dates;
  }
  const nights = Math.max(1, Number(dates.nights) || 1);
  const checkIn = new Date(`${dates.checkIn}T00:00:00Z`);
  const rangeStart = new Date(`${monitor.dateStart}T00:00:00Z`);
  const rangeEnd = new Date(`${monitor.dateEnd}T00:00:00Z`);
  const latestCheckIn = addUtcDays(rangeEnd, -nights);
  if (
    ![checkIn, rangeStart, rangeEnd, latestCheckIn].every((date) =>
      Number.isFinite(date.getTime())
    )
  ) {
    return dates;
  }
  const start = new Date(
    Math.max(rangeStart.getTime(), addUtcDays(checkIn, -7).getTime()),
  );
  const end = new Date(
    Math.min(latestCheckIn.getTime(), addUtcDays(checkIn, 7).getTime()),
  );
  return {
    ...dates,
    flexibleWindowDays: 7,
    flexibleCheckInStart: isoDay(start),
    flexibleCheckInEnd: isoDay(end),
  };
}

function monitorSeed(value) {
  return String(value || "")
    .split("")
    .reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 10007, 0);
}

function flexibleSearchShape(monitor) {
  const windowDays = Math.max(
    30,
    Math.min(365, Number(monitor.windowDays) || 180),
  );
  const minNights = Math.max(1, Number(monitor.minNights) || 4);
  const maxNights = Math.max(
    minNights,
    Math.min(minNights + 13, Number(monitor.maxNights) || minNights),
  );
  const stayOptions = maxNights - minNights + 1;
  const dateWindows = Math.ceil(windowDays / FLEXIBLE_WINDOW_SPAN);
  return {
    windowDays,
    minNights,
    maxNights,
    stayOptions,
    dateWindows,
    exactCombinations: windowDays * stayOptions,
    combinations: dateWindows * stayOptions,
  };
}

function rangeSearchShape(monitor) {
  const dateStart = String(monitor.dateStart || "");
  const dateEnd = String(monitor.dateEnd || "");
  const startTimestamp = Date.parse(`${dateStart}T00:00:00Z`);
  const endTimestamp = Date.parse(`${dateEnd}T00:00:00Z`);
  const rangeDays = Number.isFinite(startTimestamp) && Number.isFinite(endTimestamp)
    ? Math.max(0, Math.round((endTimestamp - startTimestamp) / 86_400_000))
    : 0;
  const minNights = Math.max(1, Number(monitor.minNights) || 1);
  const requestedMaxNights = Math.max(
    minNights,
    Math.min(minNights + 13, Number(monitor.maxNights) || minNights),
  );
  const maxNights = Math.min(requestedMaxNights, rangeDays);
  let combinations = 0;
  for (let dayOffset = 0; dayOffset < rangeDays; dayOffset += 1) {
    combinations += Math.max(
      0,
      Math.min(maxNights, rangeDays - dayOffset) - minNights + 1,
    );
  }
  return {
    dateStart,
    dateEnd,
    rangeDays,
    minNights,
    maxNights,
    stayOptions: Math.max(0, maxNights - minNights + 1),
    exactCombinations: combinations,
    combinations,
  };
}

function rangeSearchAtIndex(shape, requestedIndex) {
  let index = requestedIndex;
  for (let dayOffset = 0; dayOffset < shape.rangeDays; dayOffset += 1) {
    const optionsForDay = Math.max(
      0,
      Math.min(shape.maxNights, shape.rangeDays - dayOffset) -
        shape.minNights +
        1,
    );
    if (index < optionsForDay) {
      return {
        dayOffset,
        nights: shape.minNights + index,
      };
    }
    index -= optionsForDay;
  }
  return null;
}

function buildMonitorSearches(monitor, now = new Date(), options = {}) {
  if (monitor.dateMode === "fixed") {
    return [{ checkIn: monitor.dateStart, checkOut: monitor.dateEnd }];
  }

  if (monitor.dateMode === "range") {
    const shape = rangeSearchShape(monitor);
    if (!shape.combinations) return [];
    const hasPersistentCursor =
      options.startIndex !== undefined &&
      options.startIndex !== null &&
      Number.isFinite(Number(options.startIndex));
    const slot = Math.floor(now.getTime() / FIVE_MINUTES_MS);
    const startIndex = hasPersistentCursor
      ? Math.max(0, Math.floor(Number(options.startIndex))) % shape.combinations
      : (slot * FLEXIBLE_SEARCHES_PER_RUN + monitorSeed(monitor.id) * 29) %
        shape.combinations;
    const searchesThisRun = hasPersistentCursor
      ? Math.min(FLEXIBLE_SEARCHES_PER_RUN, shape.combinations - startIndex)
      : Math.min(FLEXIBLE_SEARCHES_PER_RUN, shape.combinations);
    const anchorDate = new Date(`${shape.dateStart}T00:00:00Z`);

    return Array.from({ length: searchesThisRun }, (_, offset) => {
      const index = (startIndex + offset) % shape.combinations;
      const stay = rangeSearchAtIndex(shape, index);
      const checkInDate = addUtcDays(anchorDate, stay.dayOffset);
      return {
        checkIn: isoDay(checkInDate),
        checkOut: isoDay(addUtcDays(checkInDate, stay.nights)),
        nights: stay.nights,
      };
    });
  }

  const shape = flexibleSearchShape(monitor);
  const anchorDate = options.anchorDate
    ? new Date(`${options.anchorDate}T00:00:00Z`)
    : new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
  const slot = Math.floor(now.getTime() / FIVE_MINUTES_MS);
  const hasPersistentCursor =
    options.startIndex !== undefined &&
    options.startIndex !== null &&
    Number.isFinite(Number(options.startIndex));
  const startIndex = hasPersistentCursor
    ? Math.max(0, Math.floor(Number(options.startIndex))) %
      shape.combinations
    : (slot * FLEXIBLE_SEARCHES_PER_RUN + monitorSeed(monitor.id) * 29) %
      shape.combinations;
  const searchesThisRun = hasPersistentCursor
    ? Math.min(
        FLEXIBLE_SEARCHES_PER_RUN,
        shape.combinations - startIndex,
      )
    : FLEXIBLE_SEARCHES_PER_RUN;

  return Array.from({ length: searchesThisRun }, (_, offset) => {
    const index = (startIndex + offset) % shape.combinations;
    const windowIndex = Math.floor(index / shape.stayOptions);
    const windowStartOffset =
      windowIndex * FLEXIBLE_WINDOW_SPAN + 1;
    const windowEndOffset = Math.min(
      shape.windowDays,
      windowStartOffset + FLEXIBLE_WINDOW_SPAN - 1,
    );
    const dayOffset = Math.floor(
      (windowStartOffset + windowEndOffset) / 2,
    );
    const nights = shape.minNights + (index % shape.stayOptions);
    const checkInDate = addUtcDays(anchorDate, dayOffset);
    return {
      checkIn: isoDay(checkInDate),
      checkOut: isoDay(addUtcDays(checkInDate, nights)),
      nights,
      flexibleWindowDays: FLEXIBLE_WINDOW_DAYS,
      flexibleCheckInStart: isoDay(
        addUtcDays(anchorDate, windowStartOffset),
      ),
      flexibleCheckInEnd: isoDay(
        addUtcDays(anchorDate, windowEndOffset),
      ),
    };
  });
}

function buildMonitorScanRequests(
  monitor,
  nearbyLocations = [],
  now = new Date(),
  options = {},
) {
  const dates = buildMonitorSearches(monitor, now, options);
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
    locationType: monitor.locationType || "",
    locationCity: monitor.locationCity || "",
    locationRadiusKm: Number(monitor.locationRadiusKm) || 0,
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    flexibleWindowDays: dates.flexibleWindowDays || 0,
    flexibleCheckInStart: dates.flexibleCheckInStart || dates.checkIn,
    flexibleCheckInEnd: dates.flexibleCheckInEnd || dates.checkIn,
    adults: monitor.adults,
    children: monitor.children,
    rooms: monitor.rooms,
    maxTotal: monitor.maxTotal,
    maxNightly: monitor.maxNightly,
    priceRule: monitor.priceMatch === "both" ? "and" : "or",
    priceSafetyPercent: monitor.priceSafetyPercent ?? 5,
    minStars: monitor.minStars,
    guestRatingMin: monitor.guestRatingMin,
    maxDistanceKm: Number(monitor.maxDistanceKm) || 0,
    freeCancellation: monitor.freeCancellation,
    mealPlan: monitor.mealPlan,
    propertyTypes: monitor.propertyTypes,
    amenities: monitor.amenities,
    excludeSharedRooms: true,
    maxResults: Number(monitor.maxDistanceKm) > 0 ? 25 : 30,
    // Direct scrapers revisit the cheapest candidates to confirm the final total.
    // Keeping this small prevents one promising date from consuming a whole cycle.
    maxVerifiedResults: 2,
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
  bookingDiscoveryDates,
  buildMonitorScanRequests,
  buildMonitorSearches,
  flexibleSearchShape,
  monitorIsDue,
  monitorToSearch,
  parseTimestamp,
  rangeSearchShape,
  runRemoteScan,
};
