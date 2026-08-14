const SOURCE_POLICIES = {
  booking: { failureThreshold: 2, cooldownMinutes: 15 },
  google_hotels: { failureThreshold: 2, cooldownMinutes: 60 },
  agoda: { failureThreshold: 3, cooldownMinutes: 15 },
  trip: { failureThreshold: 3, cooldownMinutes: 15 },
  bluepillow: { failureThreshold: 3, cooldownMinutes: 15 },
};

const GOOGLE_MAX_ADVANCE_DAYS = 330;
const GOOGLE_PROBE_INTERVAL_MS = 60 * 60_000;

function sourcePolicy(source) {
  return SOURCE_POLICIES[source] || {
    failureThreshold: 3,
    cooldownMinutes: 15,
  };
}

function sourceCanRun(health = {}, source, now = new Date()) {
  const entry = health[source] || {};
  const suspendedUntil = Date.parse(entry.suspendedUntil || "");
  if (Number.isFinite(suspendedUntil) && suspendedUntil > now.getTime()) {
    return {
      run: false,
      reason: "cooldown",
      retryAt: new Date(suspendedUntil).toISOString(),
    };
  }
  return { run: true, reason: "ready", retryAt: "" };
}

function recordSourceSuccess(health = {}, source, checkedAt = new Date()) {
  return {
    ...health,
    [source]: {
      ...(health[source] || {}),
      consecutiveErrors: 0,
      suspendedUntil: "",
      lastSuccessAt: checkedAt.toISOString(),
      lastAttemptAt: checkedAt.toISOString(),
      lastError: "",
    },
  };
}

function recordSourceFailure(
  health = {},
  source,
  error,
  checkedAt = new Date(),
) {
  const previous = health[source] || {};
  const consecutiveErrors = Number(previous.consecutiveErrors || 0) + 1;
  const policy = sourcePolicy(source);
  const suspendedUntil = consecutiveErrors >= policy.failureThreshold
    ? new Date(
        checkedAt.getTime() + policy.cooldownMinutes * 60_000,
      ).toISOString()
    : "";
  return {
    ...health,
    [source]: {
      ...previous,
      consecutiveErrors,
      suspendedUntil,
      lastAttemptAt: checkedAt.toISOString(),
      lastError: error instanceof Error ? error.message : String(error || ""),
    },
  };
}

function recordSourceAttempt(health = {}, source, checkedAt = new Date()) {
  return {
    ...health,
    [source]: {
      ...(health[source] || {}),
      lastAttemptAt: checkedAt.toISOString(),
    },
  };
}

function googleDateEligibility(checkIn, now = new Date()) {
  const date = Date.parse(`${String(checkIn || "")}T12:00:00Z`);
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    12,
  );
  if (!Number.isFinite(date)) {
    return { eligible: false, reason: "invalid_date", daysAhead: null };
  }
  const daysAhead = Math.round((date - today) / 86_400_000);
  if (daysAhead < 0) {
    return { eligible: false, reason: "past_date", daysAhead };
  }
  if (daysAhead > GOOGLE_MAX_ADVANCE_DAYS) {
    return { eligible: false, reason: "calendar_limit", daysAhead };
  }
  return { eligible: true, reason: "ready", daysAhead };
}

function googleProbeIsDue(health = {}, now = new Date()) {
  const lastAttempt = Date.parse(health.google_hotels?.lastAttemptAt || "");
  return (
    !Number.isFinite(lastAttempt) ||
    now.getTime() - lastAttempt >= GOOGLE_PROBE_INTERVAL_MS
  );
}

module.exports = {
  GOOGLE_MAX_ADVANCE_DAYS,
  GOOGLE_PROBE_INTERVAL_MS,
  SOURCE_POLICIES,
  googleDateEligibility,
  googleProbeIsDue,
  recordSourceAttempt,
  recordSourceFailure,
  recordSourceSuccess,
  sourceCanRun,
  sourcePolicy,
};
