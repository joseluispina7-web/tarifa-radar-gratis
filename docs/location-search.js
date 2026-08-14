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
    "station",
    "airport",
    "amenity",
    "shop",
    "poi",
  ]);

  const CHINA_MUNICIPALITIES = [
    "beijing",
    "chongqing",
    "hong kong",
    "macao",
    "macau",
    "shanghai",
    "tianjin",
  ];

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
      station: "Estaci\u00f3n",
      airport: "Aeropuerto",
      amenity: "Lugar",
      shop: "Comercio",
      poi: "Lugar",
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
        "airport",
        "amenity",
        "shop",
        "poi",
      ].includes(normalized)
    ) {
      return 3;
    }
    if (normalized === "station") return 2;
    return 0;
  }

  function distanceKm(leftLatitude, leftLongitude, rightLatitude, rightLongitude) {
    const values = [
      leftLatitude,
      leftLongitude,
      rightLatitude,
      rightLongitude,
    ].map(Number);
    if (!values.every(Number.isFinite)) return Infinity;
    const [lat1, lon1, lat2, lon2] = values.map(
      (value) => (value * Math.PI) / 180,
    );
    const latitudeDelta = lat2 - lat1;
    const longitudeDelta = lon2 - lon1;
    const a =
      Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) *
        Math.sin(longitudeDelta / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function photonLocationType(properties) {
    const key = String(properties.osm_key || "").toLowerCase();
    const type = String(properties.type || properties.osm_value || "place")
      .toLowerCase();
    if (key === "highway" || type === "street") return "road";
    if (key === "railway" || type === "station" || type === "stop") {
      return "station";
    }
    if (key === "aeroway" || /airport|aerodrome/.test(type)) return "airport";
    if (key === "tourism") return "tourism";
    if (key === "amenity" || key === "leisure" || key === "historic") {
      return "amenity";
    }
    if (key === "shop") return "shop";
    if (type === "house" && properties.housenumber) return "house";
    return type;
  }

  function normalizeMunicipalityName(value) {
    return String(value || "")
      .replace(/\s+(?:municipality|city)$/i, "")
      .trim();
  }

  function photonParentCity(properties, context, latitude, longitude) {
    const countryCode = String(properties.countrycode || "").toUpperCase();
    const contextCountry = String(context?.countryCode || "").toUpperCase();
    if (
      context?.locationCity &&
      (!contextCountry || !countryCode || contextCountry === countryCode) &&
      distanceKm(
        latitude,
        longitude,
        context.latitude,
        context.longitude,
      ) <= 120
    ) {
      return String(context.locationCity).trim();
    }

    const state = normalizeMunicipalityName(properties.state);
    if (
      countryCode === "CN" &&
      CHINA_MUNICIPALITIES.includes(state.toLowerCase())
    ) {
      return state;
    }
    return String(properties.city || state || properties.district || "").trim();
  }

  function normalizePhotonLocation(feature, context = null) {
    const properties = feature?.properties || {};
    const coordinates = feature?.geometry?.coordinates || [];
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);
    const type = photonLocationType(properties);
    const name = String(
      properties.name || properties.street || properties.locality || "",
    ).trim();
    const city = photonParentCity(properties, context, latitude, longitude);
    const district = String(properties.district || properties.locality || "").trim();
    const label = compactParts([
      properties.housenumber ? `${name} ${properties.housenumber}` : name,
      district,
      city,
      properties.state,
      properties.country,
    ]).join(", ");
    const details = compactParts([
      locationTypeLabel(type),
      properties.street !== name ? properties.street : "",
      properties.locality !== district ? properties.locality : "",
      properties.postcode,
    ]).join(" · ");

    return {
      id:
        "photon:" +
        String(properties.osm_type || "place") +
        ":" +
        String(properties.osm_id || label),
      name,
      label,
      details,
      latitude,
      longitude,
      countryCode: String(properties.countrycode || "").toUpperCase(),
      locationType: type,
      locationCity: city || name,
      locationRadiusKm: locationRadiusKm(type),
      source: "photon",
    };
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

  function nominatimLocationType(item) {
    const type = String(item.addresstype || item.type || "place").toLowerCase();
    const category = String(item.category || item.class || "").toLowerCase();
    if (category === "railway" || type === "railway") return "station";
    if (category === "aeroway" || /airport|aerodrome/.test(type)) {
      return "airport";
    }
    if (category === "tourism") return "tourism";
    if (["amenity", "leisure", "historic"].includes(category)) {
      return "amenity";
    }
    if (category === "shop") return "shop";
    return type;
  }

  function normalizeNominatimLocation(item) {
    const address = item.address || {};
    const type = nominatimLocationType(item);
    const namedetails = item.namedetails || {};
    const city = String(
      address.city ||
        address.town ||
        address.village ||
        address.municipality ||
        address.county ||
        "",
    ).trim();
    const name = String(
      namedetails["name:es"] ||
        namedetails["name:en"] ||
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
    normalizePhotonLocation,
  };
});
