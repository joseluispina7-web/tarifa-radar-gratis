const PHOTON_REVERSE_URL = "https://photon.komoot.io/reverse";
const SAMPLE_BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];

function normalizePlaceName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function buildRadiusSamplePoints(latitude, longitude, radiusKm) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  const radius = Number(radiusKm);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    return [];
  }

  const sampleDistanceKm = radius * 0.8;
  const latitudeRadians = lat * Math.PI / 180;
  return SAMPLE_BEARINGS.map((bearing) => {
    const angle = bearing * Math.PI / 180;
    const northKm = Math.cos(angle) * sampleDistanceKm;
    const eastKm = Math.sin(angle) * sampleDistanceKm;
    return {
      latitude: lat + northKm / 111.32,
      longitude:
        lon + eastKm / (111.32 * Math.max(0.2, Math.cos(latitudeRadians))),
      sampleDistanceKm,
    };
  });
}

function collectPlaceNames(payload, countryCode = "") {
  const expectedCountry = String(countryCode || "").toUpperCase();
  const names = [];
  for (const feature of payload?.features || []) {
    const properties = feature?.properties || {};
    const featureCountry = String(properties.countrycode || "").toUpperCase();
    if (
      expectedCountry &&
      featureCountry &&
      featureCountry !== expectedCountry
    ) {
      continue;
    }
    for (const key of ["city", "town", "village"]) {
      const name = String(properties[key] || "").trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

async function reversePoint(point, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const url = new URL(PHOTON_REVERSE_URL);
  url.searchParams.set("lat", String(point.latitude));
  url.searchParams.set("lon", String(point.longitude));
  url.searchParams.set("limit", "5");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(options.timeoutMs) || 8_000,
  );
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        "user-agent": "TarifaRadar/1.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`El mapa respondio ${response.status}.`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency(values, concurrency, callback) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await callback(values[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  );
  return results;
}

async function discoverNearbyLocations(monitor, options = {}) {
  const radiusKm = Number(monitor.maxDistanceKm) || 0;
  const points = buildRadiusSamplePoints(
    monitor.latitude,
    monitor.longitude,
    radiusKm,
  );
  if (!points.length) return [];

  const responses = await mapWithConcurrency(
    points,
    Number(options.concurrency) || 2,
    (point) => reversePoint(point, options),
  );
  const successful = responses.filter((result) =>
    result.status === "fulfilled"
  );
  if (!successful.length) {
    throw new Error("El mapa no ha podido resolver las localidades cercanas.");
  }

  const mainName = String(monitor.location || "").split(",")[0].trim();
  const normalizedMainName = normalizePlaceName(mainName);
  const countryLabel =
    String(monitor.location || "").split(",").at(-1)?.trim() || "";
  const seen = new Set([normalizedMainName]);
  const nearby = [];

  for (const [index, result] of responses.entries()) {
    if (result.status !== "fulfilled") continue;
    for (const name of collectPlaceNames(
      result.value,
      monitor.countryCode,
    )) {
      const normalized = normalizePlaceName(name);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      nearby.push({
        name,
        query: countryLabel ? `${name}, ${countryLabel}` : name,
        sampleDistanceKm:
          Math.round(points[index].sampleDistanceKm * 100) / 100,
      });
    }
  }

  return nearby.slice(0, Number(options.maxLocations) || 6);
}

module.exports = {
  buildRadiusSamplePoints,
  collectPlaceNames,
  discoverNearbyLocations,
  normalizePlaceName,
};
