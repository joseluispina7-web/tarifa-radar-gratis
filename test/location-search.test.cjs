const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isDetailedLocation,
  mergeLocationResults,
  normalizeNominatimLocation,
  normalizeOpenMeteoLocation,
  normalizePhotonLocation,
} = require("../docs/location-search.js");

test("normalizes a neighbourhood with its parent city and safe radius", () => {
  const location = normalizeNominatimLocation({
    place_id: 290075566,
    osm_type: "node",
    osm_id: 1862928844,
    lat: "40.4267079",
    lon: "-3.7042311",
    type: "neighbourhood",
    addresstype: "neighbourhood",
    name: "Malasaña",
    display_name:
      "Malasaña, Universidad, Centro, Madrid, Comunidad de Madrid, España",
    address: {
      neighbourhood: "Malasaña",
      quarter: "Universidad",
      city_district: "Centro",
      city: "Madrid",
      state: "Comunidad de Madrid",
      postcode: "28004",
      country: "España",
      country_code: "es",
    },
  });

  assert.equal(location.label, "Malasaña, Madrid, España");
  assert.equal(location.locationCity, "Madrid");
  assert.equal(location.locationType, "neighbourhood");
  assert.equal(location.locationRadiusKm, 3);
  assert.equal(location.countryCode, "ES");
  assert.equal(isDetailedLocation(location), true);
  assert.match(location.details, /Barrio/);
  assert.match(location.details, /Centro/);
});

test("normalizes streets and keeps city results compatible", () => {
  const street = normalizeNominatimLocation({
    place_id: 1,
    osm_type: "way",
    osm_id: 2,
    lat: "40.4220401",
    lon: "-3.7087133",
    type: "tertiary",
    addresstype: "road",
    name: "Gran Vía",
    address: {
      road: "Gran Vía",
      neighbourhood: "Malasaña",
      city: "Madrid",
      state: "Comunidad de Madrid",
      country: "España",
      country_code: "es",
    },
  });
  const city = normalizeOpenMeteoLocation({
    id: 3117735,
    name: "Madrid",
    latitude: 40.4165,
    longitude: -3.70256,
    country_code: "ES",
    country: "España",
    admin1: "Comunidad de Madrid",
    feature_code: "PPLC",
  });

  assert.equal(street.label, "Gran Vía, Madrid, España");
  assert.equal(street.locationRadiusKm, 2);
  assert.equal(city.locationRadiusKm, 0);
  assert.equal(city.locationCity, "Madrid");
  assert.equal(mergeLocationResults([street], [street, city]).length, 2);
});

test("normalizes a Shanghai street from Photon with city context", () => {
  const street = normalizePhotonLocation(
    {
      properties: {
        osm_type: "W",
        osm_id: 177993351,
        osm_key: "highway",
        osm_value: "pedestrian",
        type: "street",
        name: "East Nanjing Road",
        locality: "Waitanyuan",
        district: "Waitan",
        city: "Huangpu",
        state: "Shanghai",
        country: "China",
        postcode: "200002",
        countrycode: "CN",
      },
      geometry: {
        type: "Point",
        coordinates: [121.4842575, 31.2407165],
      },
    },
    {
      latitude: 31.2304,
      longitude: 121.4737,
      locationCity: "Shanghai",
      countryCode: "CN",
    },
  );

  assert.match(street.label, /^East Nanjing Road/);
  assert.match(street.label, /Shanghai/);
  assert.equal(street.locationCity, "Shanghai");
  assert.equal(street.locationType, "road");
  assert.equal(street.locationRadiusKm, 2);
  assert.equal(street.countryCode, "CN");
  assert.equal(isDetailedLocation(street), true);
});

test("recognizes stations before Photon's generic house type", () => {
  const station = normalizePhotonLocation({
    properties: {
      osm_type: "N",
      osm_id: 468916502,
      osm_key: "railway",
      osm_value: "station",
      type: "house",
      name: "East Nanjing Road",
      city: "Huangpu",
      state: "Shanghai",
      country: "China",
      countrycode: "CN",
    },
    geometry: { type: "Point", coordinates: [121.4792291, 31.2391239] },
  });

  assert.equal(station.locationType, "station");
  assert.equal(station.locationRadiusKm, 2);
});
