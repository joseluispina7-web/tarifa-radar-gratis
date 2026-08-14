const assert = require("node:assert/strict");
const test = require("node:test");
const {
  googleDateEligibility,
  googleProbeIsDue,
  recordSourceFailure,
  recordSourceSuccess,
  sourceCanRun,
} = require("../src/source-health.cjs");

test("pauses Booking after repeated errors and restores it after cooldown", () => {
  const now = new Date("2026-08-14T18:00:00Z");
  let health = recordSourceFailure({}, "booking", "timeout", now);
  assert.equal(sourceCanRun(health, "booking", now).run, true);
  health = recordSourceFailure(health, "booking", "timeout", now);
  assert.equal(sourceCanRun(health, "booking", now).run, false);
  assert.equal(
    sourceCanRun(health, "booking", new Date("2026-08-14T18:16:00Z")).run,
    true,
  );
  health = recordSourceSuccess(
    health,
    "booking",
    new Date("2026-08-14T18:16:00Z"),
  );
  assert.equal(health.booking.consecutiveErrors, 0);
  assert.equal(health.booking.lastError, "");
});

test("does not spend Google attempts beyond the reliable calendar horizon", () => {
  const now = new Date("2026-08-14T12:00:00Z");
  assert.equal(googleDateEligibility("2027-07-01", now).eligible, true);
  assert.deepEqual(googleDateEligibility("2027-07-26", now), {
    eligible: false,
    reason: "calendar_limit",
    daysAhead: 346,
  });
});

test("probes Google periodically when there are no discovery candidates", () => {
  const now = new Date("2026-08-14T18:00:00Z");
  assert.equal(googleProbeIsDue({}, now), true);
  assert.equal(
    googleProbeIsDue(
      { google_hotels: { lastAttemptAt: "2026-08-14T17:30:00Z" } },
      now,
    ),
    false,
  );
  assert.equal(
    googleProbeIsDue(
      { google_hotels: { lastAttemptAt: "2026-08-14T16:30:00Z" } },
      now,
    ),
    true,
  );
});
