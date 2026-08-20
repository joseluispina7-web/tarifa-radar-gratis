const crypto = require("node:crypto");
const {
  hotelNamesMatch,
  normalizeHotelName,
} = require("./deal-intelligence.cjs");

const MAX_EXCLUDED_HOTELS = 500;

function exclusionActionId(target = {}) {
  return crypto
    .createHash("sha256")
    .update([
      String(target.monitorId || ""),
      normalizeHotelName(target.hotelName),
    ].join("|"))
    .digest("hex")
    .slice(0, 16);
}

function normalizeExclusionsDocument(document = {}) {
  const hotels = Array.isArray(document.hotels)
    ? document.hotels
        .filter((entry) => entry?.monitorId && entry?.hotelName)
        .slice(-MAX_EXCLUDED_HOTELS)
    : [];
  return {
    version: 1,
    updatedAt: document.updatedAt || "",
    hotels,
  };
}

function hotelIsExcluded(document, monitorId, hotelName) {
  return normalizeExclusionsDocument(document).hotels.some((entry) =>
    String(entry.monitorId) === String(monitorId) &&
    hotelNamesMatch(entry.hotelName, hotelName)
  );
}

function addHotelExclusion(document, target, now = new Date()) {
  const current = normalizeExclusionsDocument(document);
  const existing = current.hotels.find((entry) =>
    String(entry.monitorId) === String(target.monitorId) &&
    hotelNamesMatch(entry.hotelName, target.hotelName)
  );
  if (existing) {
    return { document: current, entry: existing, added: false };
  }

  const entry = {
    id: exclusionActionId(target),
    monitorId: String(target.monitorId),
    monitorName: String(target.monitorName || "Busqueda"),
    hotelName: String(target.hotelName).trim(),
    source: String(target.source || ""),
    excludedAt: now.toISOString(),
    origin: String(target.origin || "telegram"),
  };
  return {
    document: {
      version: 1,
      updatedAt: now.toISOString(),
      hotels: [...current.hotels, entry].slice(-MAX_EXCLUDED_HOTELS),
    },
    entry,
    added: true,
  };
}

module.exports = {
  MAX_EXCLUDED_HOTELS,
  addHotelExclusion,
  exclusionActionId,
  hotelIsExcluded,
  normalizeExclusionsDocument,
};
