(function locationSearchModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.TarifaLocationSearch = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const DETAILED_TYPES = new Set([
    "house",
    "building",
    "road",
    "street",
    "pedestrian",
    "residential",
    "tertiary",
    "secondary",
    "primary",
    "square",
    "neighbourhood",
    "quarter",
    "suburb",
    "borough",
    "city_district",
    "beach",
    "tourism",
  ]);

  function compactParts(parts) {
    const seen = new Set();
    return parts.filter((part) => {
      const value = String(part || "").trim();
      const key = value.toLocaleLowerCase("es");
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function locationTypeLabel(type) {
    const labels = {
      house: "Dirección",
      building: "Edificio",
      road: "Calle",
      street: "Calle",
      pedestrian: "Calle",
      residential: "Calle",
      tertiary: "Calle",
      secondary: "Calle",
      primary: "Calle",
      square: "Plaza",
      neighbourhood: "Barrio",
      quarter: "Barrio",
      suburb: "Zona",
      borough: "Distrito",
      city_district: "Distrito",
      beach: "Playa",
      tourism: "Lugar",
      city: "Ciudad",
      town: "Localidad",
      village: "Localidad",
      municipality: "Municipio",
      ppl: "Ciudad",
      ppla: "Ciudad",
      ppla2: "Ciudad",
      ppla3: "Localidad",
      pplc: "Capital",
      adm1: "Región",
      adm2: "Provincia",
      county: "Provincia",
      state: "Región",
      country: "País",
    };
    return labels[String(type || "").toLowerCase()] || "Ubicación";
  }

  function locationRadiusKm(type) {
    const normalized = String(type || "").toLowerCase();
    if (["house", "building"].includes(normalized)) return 1;
    if (
      [
        "road",
        "street",
        "pedestrian",
        "residential",
        "tertiary",
        "secondary",
        "primary",
        "square",
      ].includes(normalized)
    ) {
      return 2;
    }
    if (
      [
        "neighbourhood",
        "quarter",
        "suburb",
        "borough",
        "city_district",
        "beach",
        "tourism",
      ].includes(normalized)
    ) {
      return 3;
    }
    return 0;
  }

  function normalizeOpenMeteoLocation(item) {
    const type = String(item.feature_code || "").toLowerCase();
    return {
      id: "openmeteo:" + item.id,
      name: String(item.name || "").trim(),
      label: compactParts([item.name, item.admin1, item.country]).join(", "),
      details: compactParts([
        locationTypeLabel(type),
        item.admin2,
        item.admin3,
      ]).join(" · "),
      latitude: Number(item.latitude),
      longitude: Number(item.longitude),
      countryCode: String(item.country_code || "").toUpperCase(),
      locationType: type || "place",
      locationCity: String(item.name || "").trim(),
      locationRadiusKm: 0,
      source: "openmeteo",
    };
  }

  function normalizeNominatimLocation(item) {
    const address = item.address || {};
    const type = String(item.addresstype || item.type || "place").toLowerCase();
    const city = String(
      address.city ||
        address.town ||
        address.village ||
        address.municipality ||
        address.county ||
        "",
    ).trim();
    const name = String(
      item.name ||
        address.road ||
        address.neighbourhood ||
        address.quarter ||
        address.suburb ||
        (item.display_name || "").split(",")[0] ||
        "",
    ).trim();
    const district = String(
      address.neighbourhood ||
        address.quarter ||
        address.suburb ||
        address.city_district ||
        address.borough ||
        "",
    ).trim();
    const label = compactParts([name, city, address.country]).join(", ");
    const details = compactParts([
      locationTypeLabel(type),
      district !== name ? district : "",
      address.city_district,
      address.state,
      address.postcode,
    ]).join(" · ");

    return {
      id:
        "osm:" +
        (item.osm_type || "place") +
        ":" +
        (item.osm_id || item.place_id),
      name,
      label: label || String(item.display_name || "").trim(),
      details,
      latitude: Number(item.lat),
      longitude: Number(item.lon),
      countryCode: String(address.country_code || "").toUpperCase(),
      locationType: type,
      locationCity: city || name,
      locationRadiusKm: locationRadiusKm(type),
      source: "openstreetmap",
    };
  }

  function locationKey(location) {
    const roundedLatitude = Number(location.latitude).toFixed(4);
    const roundedLongitude = Number(location.longitude).toFixed(4);
    return [
      String(location.label || "").toLocaleLowerCase("es"),
      roundedLatitude,
      roundedLongitude,
    ].join("|");
  }

  function mergeLocationResults(...groups) {
    const merged = [];
    const seen = new Set();
    for (const location of groups.flat()) {
      if (
        !location?.label ||
        !Number.isFinite(Number(location.latitude)) ||
        !Number.isFinite(Number(location.longitude))
      ) {
        continue;
      }
      const key = locationKey(location);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(location);
    }
    return merged;
  }

  function isDetailedLocation(location) {
    return DETAILED_TYPES.has(
      String(location?.locationType || "").toLowerCase(),
    );
  }

  return {
    isDetailedLocation,
    locationRadiusKm,
    locationTypeLabel,
    mergeLocationResults,
    normalizeNominatimLocation,
    normalizeOpenMeteoLocation,
  };
});
