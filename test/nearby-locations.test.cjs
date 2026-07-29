const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildRadiusSamplePoints,
  collectPlaceNames,
  discoverNearbyLocations,
  normalizePlaceName,
} = require("../src/nearby-locations.cjs");

test("samples eight points inside the selected radius", () => {
  const points = buildRadiusSamplePoints(38.53816, -0.13098, 5);
  assert.equal(points.length, 8);
  assert.equal(points.every((point) => point.sampleDistanceKm === 4), true);
});

test("normalizes accents and keeps nearby cities in the same country", () => {
  assert.equal(normalizePlaceName("La Nucía"), "la nucia");
  assert.deepEqual(
    collectPlaceNames(
      {
        features: [
          {
            properties: {
              city: "Finestrat",
              town: "La Nucía",
              countrycode: "ES",
            },
          },
          {
            properties: { city: "Nice", countrycode: "FR" },
          },
        ],
      },
      "ES",
    ),
    ["Finestrat", "La Nucía"],
  );
});

test("discovers and deduplicates nearby locations for a monitor", async () => {
  const payloads = [
    { city: "Benidorm", countrycode: "ES" },
    { city: "La Nucía", countrycode: "ES" },
    { city: "la Nucia", countrycode: "ES" },
    { town: "Finestrat", countrycode: "ES" },
  ];
  let call = 0;
  const nearby = await discoverNearbyLocations(
    {
      location: "Benidorm, Comunitat Valenciana, España",
      latitude: 38.53816,
      longitude: -0.13098,
      countryCode: "ES",
      maxDistanceKm: 5,
    },
    {
      concurrency: 1,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          features: [{
            properties: payloads[call++] || {
              city: "Benidorm",
              countrycode: "ES",
            },
          }],
        }),
      }),
    },
  );

  assert.deepEqual(
    nearby.map((location) => location.name),
    ["La Nucía", "Finestrat"],
  );
  assert.equal(nearby[0].query, "La Nucía, España");
});
