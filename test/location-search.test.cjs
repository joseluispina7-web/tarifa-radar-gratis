const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isDetailedLocation,
  mergeLocationResults,
  normalizeNominatimLocation,
  normalizeOpenMeteoLocation,
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
