const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildDealMap,
  clearSearchedDeals,
  monitorFingerprint,
  offerStateIsConfirmed,
  priceWithinDiscoveryRange,
  resultHasPromisingCandidate,
  runRepositoryScan,
  sourceIsEnabledForMonitor,
  updateOfferState,
} = require("../src/repository-scan.cjs");

const monitor = {
  id: "search-1",
  location: "Benidorm, España",
  dateMode: "fixed",
  dateStart: "2026-08-05",
  dateEnd: "2026-08-09",
  minNights: 4,
  maxNights: 4,
  adults: 2,
  children: 0,
  rooms: 1,
  sources: ["booking"],
};

test("promotes near-budget discovery candidates to direct verification", () => {
  const search = {
    maxTotal: 500,
    maxNightly: 100,
    priceRule: "or",
  };
  assert.equal(
    priceWithinDiscoveryRange(
      { totalPrice: 590, nightlyPrice: 120 },
      search,
    ),
    true,
  );
  assert.equal(
    priceWithinDiscoveryRange(
      { totalPrice: 650, nightlyPrice: 130 },
      search,
    ),
    false,
  );
  assert.equal(
    resultHasPromisingCandidate(
      { offers: [{ totalPrice: 550, nightlyPrice: 110 }] },
      search,
    ),
    true,
  );
});

test("keeps date discovery moving while a failing direct source cools down", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tarifa-radar-cycle-"));
  t.after(() => {
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()))) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const paths = ["config", "state", "docs/data"];
  for (const directory of paths) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const cycleMonitor = {
    ...monitor,
    id: "cycle-monitor",
    dateMode: "range",
    dateStart: "2026-09-01",
    dateEnd: "2026-09-10",
    minNights: 1,
    maxNights: 1,
    maxTotal: 200,
    maxNightly: 200,
    priceMatch: "or",
    strictPrices: false,
    active: true,
    intervalMinutes: 5,
    sources: ["agoda", "booking"],
  };
  fs.writeFileSync(
    path.join(root, "config/searches.json"),
    JSON.stringify({ monitors: [cycleMonitor] }),
  );
  fs.writeFileSync(
    path.join(root, "state/repository-state.json"),
    JSON.stringify({ version: 1, monitors: {} }),
  );
  fs.writeFileSync(
    path.join(root, "docs/data/deals.json"),
    JSON.stringify({ version: 1, deals: [] }),
  );

  let bookingCalls = 0;
  const resultFor = (source, search, offers = []) => ({
    source,
    search,
    searchedAt: "2026-08-14T18:00:00.000Z",
    offers,
    matchingOffers: [],
    verificationErrors: [],
  });
  const result = await runRepositoryScan({
    root,
    now: new Date("2026-08-14T18:00:00Z"),
    scrapers: {
      agoda: async (search) => resultFor("agoda", search, [{
        id: `agoda:${search.checkIn}`,
        source: "agoda",
        hotelName: "Hotel candidato",
        totalPrice: 180,
        nightlyPrice: 180,
        matches: false,
        priceVerified: false,
        checkIn: search.checkIn,
        checkOut: search.checkOut,
      }]),
      booking: async () => {
        bookingCalls += 1;
        throw new Error("Booking timeout");
      },
    },
  });

  const monitorResult = result.status.monitors[cycleMonitor.id];
  assert.equal(bookingCalls, 2);
  assert.equal(result.summary.sources.agoda.searches, 4);
  assert.equal(result.summary.sources.booking.errors, 2);
  assert.equal(result.summary.sources.booking.skipped, 0);
  assert.equal(monitorResult.sources.booking.state, "paused");
  assert.equal(monitorResult.dateCoverage.searchesCheckedThisRun, 4);
  assert.equal(monitorResult.sourceCoverage.booking.searchesCheckedThisRun, 2);
  const storedState = JSON.parse(
    fs.readFileSync(path.join(root, "state/repository-state.json"), "utf8"),
  );
  assert.equal(
    storedState.monitors[cycleMonitor.id].sourceHealth.booking.consecutiveErrors,
    2,
  );
});

test("stops between date searches and persists the completed sweep progress", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tarifa-radar-budget-"));
  t.after(() => {
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()))) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  for (const directory of ["config", "state", "docs/data"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const budgetMonitor = {
    ...monitor,
    id: "budget-monitor",
    dateMode: "range",
    dateStart: "2026-09-01",
    dateEnd: "2026-09-10",
    minNights: 1,
    maxNights: 1,
    maxTotal: 200,
    strictPrices: false,
    active: true,
    intervalMinutes: 5,
    sources: ["agoda"],
  };
  fs.writeFileSync(
    path.join(root, "config/searches.json"),
    JSON.stringify({ monitors: [budgetMonitor] }),
  );
  fs.writeFileSync(
    path.join(root, "state/repository-state.json"),
    JSON.stringify({ version: 1, monitors: {} }),
  );
  fs.writeFileSync(
    path.join(root, "docs/data/deals.json"),
    JSON.stringify({ version: 1, deals: [] }),
  );

  let calls = 0;
  const result = await runRepositoryScan({
    root,
    now: new Date("2026-08-14T18:00:00Z"),
    scanBudgetMs: 50,
    requestReserveMs: 0,
    scrapers: {
      agoda: async (search) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return {
          source: "agoda",
          search,
          searchedAt: "2026-08-14T18:00:00.000Z",
          offers: [],
          matchingOffers: [],
          verificationErrors: [],
        };
      },
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.summary.timeBudgetReached, true);
  assert.equal(result.summary.stoppedEarlyMonitors, 1);
  assert.equal(result.status.health.state, "partial");
  assert.equal(result.status.health.completedNormally, false);
  assert.equal(
    result.status.monitors[budgetMonitor.id].dateCoverage.searchesCheckedThisRun,
    1,
  );
  const storedState = JSON.parse(
    fs.readFileSync(path.join(root, "state/repository-state.json"), "utf8"),
  );
  assert.equal(storedState.monitors[budgetMonitor.id].dateSweepCursor, 1);
});

test("caps expensive direct sources while discovery covers every date", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tarifa-radar-direct-"));
  t.after(() => {
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()))) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  for (const directory of ["config", "state", "docs/data"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const directMonitor = {
    ...monitor,
    id: "direct-monitor",
    dateMode: "range",
    dateStart: "2026-09-01",
    dateEnd: "2026-09-10",
    minNights: 1,
    maxNights: 1,
    maxTotal: 200,
    strictPrices: false,
    active: true,
    intervalMinutes: 5,
    sources: ["agoda", "booking", "google_hotels"],
  };
  fs.writeFileSync(
    path.join(root, "config/searches.json"),
    JSON.stringify({ monitors: [directMonitor] }),
  );
  fs.writeFileSync(
    path.join(root, "state/repository-state.json"),
    JSON.stringify({ version: 1, monitors: {} }),
  );
  fs.writeFileSync(
    path.join(root, "docs/data/deals.json"),
    JSON.stringify({ version: 1, deals: [] }),
  );

  const calls = { agoda: [], booking: [], google_hotels: [] };
  const resultFor = (source, search, offers = []) => ({
    source,
    search,
    searchedAt: "2026-08-14T18:00:00.000Z",
    offers,
    matchingOffers: [],
    verificationErrors: [],
  });
  const result = await runRepositoryScan({
    root,
    now: new Date("2026-08-14T18:00:00Z"),
    scrapers: {
      agoda: async (search) => {
        calls.agoda.push(search.checkIn);
        return resultFor("agoda", search, [{
          id: `agoda:${search.checkIn}:${search.checkOut}`,
          source: "agoda",
          hotelName: "Hotel candidato",
          totalPrice: 180,
          nightlyPrice: 180,
          matches: false,
          priceVerified: false,
          checkIn: search.checkIn,
          checkOut: search.checkOut,
          nights: search.nights,
        }]);
      },
      booking: async (search) => {
        calls.booking.push(search.checkIn);
        return resultFor("booking", search);
      },
      google_hotels: async (search) => {
        calls.google_hotels.push(search.checkIn);
        return resultFor("google_hotels", search);
      },
    },
  });

  assert.deepEqual(calls, {
    agoda: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
    booking: ["2026-09-01", "2026-09-02"],
    google_hotels: ["2026-09-01"],
  });
  assert.equal(
    result.status.monitors[directMonitor.id].dateCoverage.searchesCheckedThisRun,
    4,
  );
  assert.equal(
    result.status.monitors[directMonitor.id].sourceCoverage.booking.nextIndex,
    2,
  );
  assert.equal(
    result.status.monitors[directMonitor.id].sourceCoverage.google_hotels.nextIndex,
    1,
  );

  calls.agoda.length = 0;
  calls.booking.length = 0;
  calls.google_hotels.length = 0;
  await runRepositoryScan({
    root,
    now: new Date("2026-08-14T18:05:00Z"),
    scrapers: {
      agoda: async (search) => {
        calls.agoda.push(search.checkIn);
        return resultFor("agoda", search);
      },
      booking: async (search) => {
        calls.booking.push(search.checkIn);
        return resultFor("booking", search);
      },
      google_hotels: async (search) => {
        calls.google_hotels.push(search.checkIn);
        return resultFor("google_hotels", search);
      },
    },
  });
  assert.deepEqual(calls, {
    agoda: ["2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"],
    booking: ["2026-09-03", "2026-09-04"],
    google_hotels: ["2026-09-02"],
  });
});

test("drops deals created for an older monitor configuration", () => {
  const currentFingerprint = monitorFingerprint(monitor);
  const deals = buildDealMap(
    {
      deals: [
        {
          id: "old-madrid",
          monitorId: monitor.id,
          monitorFingerprint: "old-config",
        },
        {
          id: "current-benidorm",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          priceBasis: "booking_visible_final_total_v5",
        },
      ],
    },
    [monitor],
  );
  assert.deepEqual(Array.from(deals.keys()), ["current-benidorm"]);
});

test("replaces only deals for the date pair just searched", () => {
  const deals = new Map([
    [
      "searched",
      {
        monitorId: monitor.id,
        checkIn: "2026-08-05",
        checkOut: "2026-08-09",
      },
    ],
    [
      "other-dates",
      {
        monitorId: monitor.id,
        checkIn: "2026-08-12",
        checkOut: "2026-08-16",
      },
    ],
  ]);
  clearSearchedDeals(deals, monitor.id, {
    checkIn: "2026-08-05",
    checkOut: "2026-08-09",
  });
  assert.deepEqual(Array.from(deals.keys()), ["other-dates"]);
});

test("drops old Bluepillow deals that were never revalidated", () => {
  const comparisonMonitor = { ...monitor, strictPrices: false };
  const currentFingerprint = monitorFingerprint(comparisonMonitor);
  const deals = buildDealMap(
    {
      deals: [
        {
          id: "old-bluepillow",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "bluepillow",
        },
        {
          id: "validated-bluepillow",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "bluepillow",
          priceConfirmedAt: "2026-07-30T08:00:00.000Z",
        },
      ],
    },
    [comparisonMonitor],
  );
  assert.deepEqual(Array.from(deals.keys()), ["validated-bluepillow"]);
});

test("strict price mode drops indirect comparison deals", () => {
  const strictMonitor = { ...monitor, strictPrices: true };
  const currentFingerprint = monitorFingerprint(strictMonitor);
  const deals = buildDealMap(
    {
      deals: [
        {
          id: "booking-direct",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "booking",
          priceBasis: "booking_visible_final_total_v5",
        },
        {
          id: "trip-indirect",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "trip",
          priceConfirmedAt: "2026-08-10T16:00:00.000Z",
        },
        {
          id: "trip-direct",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "trip",
          priceBasis: "trip_direct_final_total_v1",
          priceConfirmedAt: "2026-08-10T19:00:00.000Z",
        },
      ],
    },
    [strictMonitor],
  );
  assert.deepEqual(Array.from(deals.keys()), ["booking-direct", "trip-direct"]);
  assert.equal(sourceIsEnabledForMonitor(strictMonitor, "booking"), true);
  assert.equal(sourceIsEnabledForMonitor(strictMonitor, "trip"), true);
  assert.equal(
    sourceIsEnabledForMonitor({ ...strictMonitor, strictPrices: false }, "trip"),
    true,
  );
});

test("drops Booking deals created by an older price parser", () => {
  const currentFingerprint = monitorFingerprint(monitor);
  const deals = buildDealMap(
    {
      deals: [
        {
          id: "old-booking",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "booking",
          priceBasis: "booking_availability_table_with_country_tax",
        },
        {
          id: "current-booking",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "booking",
          priceBasis: "booking_visible_final_total_v5",
        },
      ],
    },
    [monitor],
  );
  assert.deepEqual(Array.from(deals.keys()), ["current-booking"]);
});

test("drops Google deals created by the old nightly-price parser", () => {
  const currentFingerprint = monitorFingerprint(monitor);
  const deals = buildDealMap(
    {
      deals: [
        {
          id: "old-google",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "google_hotels",
          priceBasis: "google_hotels_provider_all_inclusive",
        },
        {
          id: "old-google-v2",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "google_hotels",
          priceBasis: "google_hotels_provider_all_inclusive_v2",
        },
        {
          id: "old-google-v3",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "google_hotels",
          priceBasis: "google_hotels_provider_all_inclusive_v3",
        },
        {
          id: "old-google-v4",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "google_hotels",
          priceBasis: "google_hotels_provider_all_inclusive_v4",
        },
        {
          id: "old-google-v5",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "google_hotels",
          priceBasis: "google_hotels_provider_all_inclusive_v5",
        },
        {
          id: "current-google",
          monitorId: monitor.id,
          monitorFingerprint: currentFingerprint,
          source: "google_hotels",
          priceBasis: "google_hotels_provider_all_inclusive_v7",
        },
      ],
    },
    [monitor],
  );
  assert.deepEqual(Array.from(deals.keys()), ["current-google"]);
});

test("clears one source without deleting the other source", () => {
  const deals = new Map([
    [
      "booking",
      {
        monitorId: monitor.id,
        source: "booking",
        checkIn: "2026-08-05",
        checkOut: "2026-08-09",
      },
    ],
    [
      "google",
      {
        monitorId: monitor.id,
        source: "google_hotels",
        checkIn: "2026-08-05",
        checkOut: "2026-08-09",
      },
    ],
  ]);
  clearSearchedDeals(
    deals,
    monitor.id,
    {
      checkIn: "2026-08-05",
      checkOut: "2026-08-09",
    },
    null,
    "google_hotels",
  );
  assert.deepEqual(Array.from(deals.keys()), ["booking"]);
});

test("replaces deals covered by one flexible Booking window", () => {
  const deals = new Map([
    [
      "inside-one-night",
      {
        monitorId: monitor.id,
        checkIn: "2026-08-08",
        checkOut: "2026-08-09",
        nights: 1,
      },
    ],
    [
      "inside-two-nights",
      {
        monitorId: monitor.id,
        checkIn: "2026-08-08",
        checkOut: "2026-08-10",
        nights: 2,
      },
    ],
    [
      "outside",
      {
        monitorId: monitor.id,
        checkIn: "2026-08-20",
        checkOut: "2026-08-21",
        nights: 1,
      },
    ],
  ]);
  clearSearchedDeals(deals, monitor.id, {
    checkIn: "2026-08-06",
    checkOut: "2026-08-07",
    nights: 1,
    flexibleCheckInStart: "2026-07-30",
    flexibleCheckInEnd: "2026-08-13",
  });
  assert.deepEqual(Array.from(deals.keys()), [
    "inside-two-nights",
    "outside",
  ]);
});

test("publishes a price after two checks in the same scan cycle", () => {
  const offer = {
    source: "google_hotels",
    hotelName: "Hotel estable",
    totalPrice: 120,
    nightlyPrice: 30,
    matches: true,
    priceVerified: true,
    priceConfirmationCount: 2,
    priceBasis: "booking_availability_table",
    searchArea: "Benidorm",
    checkIn: "2026-08-05",
    checkOut: "2026-08-09",
  };
  const first = updateOfferState(
    {},
    offer,
    "2026-07-29T08:45:00.000Z",
    "cycle-1",
  );
  assert.equal(first.confirmationCount, 2);
  assert.equal(first.source, "google_hotels");
  assert.equal(offerStateIsConfirmed(first), true);
  assert.deepEqual(first.priceHistory, [{
    at: "2026-07-29T08:45:00.000Z",
    totalPrice: 120,
    nightlyPrice: 30,
    source: "google_hotels",
    provider: "",
  }]);
  assert.equal(first.priceProof.totalPrice, 120);
  assert.equal(first.priceProof.confirmationCount, 2);

  const unconfirmed = updateOfferState(
    first,
    { ...offer, priceConfirmationCount: 1 },
    "2026-07-29T08:45:00.000Z",
    "cycle-1",
  );
  assert.equal(unconfirmed.confirmationCount, 1);
  assert.equal(offerStateIsConfirmed(unconfirmed), false);

  const changedPrice = updateOfferState(
    first,
    {
      ...offer,
      totalPrice: 130,
      nightlyPrice: 32.5,
      priceConfirmationCount: 0,
    },
    "2026-07-29T08:55:00.000Z",
    "cycle-3",
  );
  assert.equal(changedPrice.confirmationCount, 0);
  assert.equal(offerStateIsConfirmed(changedPrice), false);
  assert.deepEqual(
    changedPrice.priceHistory.map((sample) => sample.totalPrice),
    [120, 130],
  );

  const unavailable = updateOfferState(
    first,
    { ...offer, matches: false, priceVerified: false },
    "2026-07-29T08:55:00.000Z",
    "cycle-3",
  );
  assert.equal(unavailable.confirmationCount, 0);
  assert.equal(unavailable.publishedPrice, 0);
});
