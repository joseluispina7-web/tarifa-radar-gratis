const crypto = require("node:crypto");

const GENERIC_HOTEL_WORDS = new Set([
  "aparthotel",
  "apartamento",
  "apartamentos",
  "apartment",
  "apartments",
  "hotel",
  "hotels",
  "hostal",
  "hostel",
  "resort",
  "the",
]);
const ERROR_FARE_INTELLIGENCE_VERSION = 2;
const MIN_MARKET_SAMPLE = 5;
const MIN_ERROR_FARE_SAMPLE = 8;

function round(value, digits = 0) {
  const multiplier = 10 ** digits;
  return Math.round(Number(value) * multiplier) / multiplier;
}

function median(values) {
  const ordered = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (!ordered.length) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function errorFareLevel(score, evidence = {}) {
  const value = Number(score) || 0;
  const reliablePrice =
    evidence.priceVerified === true &&
    Number(evidence.priceConfirmationCount) >= 2;
  const strongMarketAnomaly =
    Number(evidence.marketSampleSize) >= MIN_ERROR_FARE_SAMPLE &&
    Number(evidence.discountPercent) >= 55;
  const corroborated =
    Number(evidence.agreeingProviderCount) >= 2 ||
    Number(evidence.priceDropPercent) >= 50;
  if (value >= 75 && reliablePrice && strongMarketAnomaly && corroborated) {
    return "probable_error";
  }
  if (value >= 55) return "unusually_low";
  if (value >= 30) return "good_price";
  return "normal";
}

function classifyErrorFare(offer) {
  const level = errorFareLevel(offer.errorFareScore, offer);
  const evidence = [];
  if (Number(offer.marketSampleSize) >= MIN_MARKET_SAMPLE) {
    evidence.push("comparable_market");
  }
  if (
    offer.priceVerified === true &&
    Number(offer.priceConfirmationCount) >= 2
  ) {
    evidence.push("verified_price");
  }
  if (Number(offer.agreeingProviderCount) >= 2) {
    evidence.push("provider_agreement");
  }
  if (Number(offer.priceDropPercent) >= 50) {
    evidence.push("confirmed_price_drop");
  }
  offer.errorFareLevel = level;
  offer.errorFareEvidence = evidence;
  offer.errorFareIntelligenceVersion = ERROR_FARE_INTELLIGENCE_VERSION;
  offer.errorFareReason = {
    probable_error:
      "Precio verificado, muy por debajo de alojamientos comparables y con una segunda evidencia.",
    unusually_low:
      "Precio muy por debajo de alojamientos comparables; no basta para afirmar que sea una tarifa error.",
    good_price: "Precio inferior a alojamientos comparables.",
    normal: "Sin evidencia suficiente de una anomalia de precio.",
  }[level];
  return offer;
}

function scoreOffer(offer, marketMedianNightly, sampleSize) {
  const nightlyPrice = Number(offer.nightlyPrice) || 0;
  const hasMarketReference =
    sampleSize >= MIN_MARKET_SAMPLE &&
    marketMedianNightly > 0 &&
    nightlyPrice > 0;
  const discountPercent = hasMarketReference && nightlyPrice < marketMedianNightly
    ? round((1 - nightlyPrice / marketMedianNightly) * 100, 1)
    : 0;
  const baseScore = Math.min(
    99,
    Math.max(0, round(discountPercent * 1.35)),
  );
  const scored = {
    marketMedianNightly: hasMarketReference
      ? round(marketMedianNightly, 2)
      : 0,
    marketSampleSize: hasMarketReference ? sampleSize : 0,
    discountPercent,
    marketErrorFareScore: baseScore,
    errorFareScore: baseScore,
  };
  return {
    ...scored,
    errorFareLevel: errorFareLevel(baseScore, { ...offer, ...scored }),
    errorFareIntelligenceVersion: ERROR_FARE_INTELLIGENCE_VERSION,
  };
}

function distanceBand(distanceKm) {
  const distance = Number(distanceKm);
  if (!Number.isFinite(distance) || distance < 0) return "";
  if (distance <= 3) return "near";
  if (distance <= 10) return "local";
  if (distance <= 25) return "area";
  return "remote";
}

function comparableOffers(offer, usable) {
  let peers = usable;
  const propertyType = String(offer.propertyType || "");
  if (propertyType) {
    const sameType = peers.filter(
      (candidate) => String(candidate.propertyType || "") === propertyType,
    );
    if (sameType.length < MIN_MARKET_SAMPLE) return [];
    peers = sameType;
  }

  const stars = Number(offer.stars) || 0;
  if (stars > 0) {
    const similarStars = peers.filter((candidate) => {
      const candidateStars = Number(candidate.stars) || 0;
      return candidateStars > 0 && Math.abs(candidateStars - stars) <= 1;
    });
    if (similarStars.length >= MIN_MARKET_SAMPLE) peers = similarStars;
  }

  const band = distanceBand(offer.distanceKm);
  if (band) {
    const sameBand = peers.filter(
      (candidate) => distanceBand(candidate.distanceKm) === band,
    );
    if (sameBand.length >= MIN_MARKET_SAMPLE) peers = sameBand;
  }
  return peers;
}

function annotateMarketPrices(offers = []) {
  const usable = offers.filter(
    (offer) =>
      Number(offer.nightlyPrice) > 0 &&
      offer.sharedRoom !== true,
  );
  const marketMedianNightly = median(
    usable.map((offer) => offer.nightlyPrice),
  );
  for (const offer of offers) {
    const peers = comparableOffers(offer, usable);
    Object.assign(
      offer,
      scoreOffer(
        offer,
        median(peers.map((candidate) => candidate.nightlyPrice)),
        peers.length,
      ),
    );
    classifyErrorFare(offer);
  }
  return {
    medianNightly: round(marketMedianNightly, 2),
    sampleSize: usable.length,
    offers,
  };
}

function applyPriceDropIntelligence(offer, previousPrice) {
  const before = Number(previousPrice) || 0;
  const current = Number(offer.totalPrice) || 0;
  const priceDropPercent = before > current && current > 0
    ? round((1 - current / before) * 100, 1)
    : 0;
  const score = Math.min(
    99,
    Number(offer.marketErrorFareScore || offer.errorFareScore || 0) +
      Math.min(15, round(priceDropPercent / 2)),
  );
  offer.priceDropPercent = priceDropPercent;
  offer.preComparisonErrorFareScore = score;
  offer.errorFareScore = score;
  return classifyErrorFare(offer);
}

function normalizeHotelName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function meaningfulHotelTokens(value) {
  return normalizeHotelName(value)
    .split(" ")
    .filter((token) => token.length > 1 && !GENERIC_HOTEL_WORDS.has(token));
}

function hotelNamesMatch(left, right) {
  const normalizedLeft = normalizeHotelName(left);
  const normalizedRight = normalizeHotelName(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const leftTokens = new Set(meaningfulHotelTokens(left));
  const rightTokens = new Set(meaningfulHotelTokens(right));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token));
  if (shared.length < 2) return false;
  const unionSize = new Set([...leftTokens, ...rightTokens]).size;
  return unionSize > 0 && shared.length / unionSize >= 0.72;
}

function comparisonContextMatches(left, right) {
  return (
    String(left.monitorId) === String(right.monitorId) &&
    left.checkIn === right.checkIn &&
    left.checkOut === right.checkOut
  );
}

function comparisonGroupId(deal) {
  return crypto
    .createHash("sha1")
    .update(
      [
        deal.monitorId,
        deal.checkIn,
        deal.checkOut,
        normalizeHotelName(deal.hotelName),
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 16);
}

function enrichDealComparisons(deals = []) {
  const groups = [];
  for (const deal of deals) {
    let group = groups.find(
      (candidate) =>
        comparisonContextMatches(candidate[0], deal) &&
        candidate.some((current) =>
          hotelNamesMatch(current.hotelName, deal.hotelName)
        ),
    );
    if (!group) {
      group = [];
      groups.push(group);
    }
    group.push(deal);
  }

  for (const group of groups) {
    const groupId = comparisonGroupId(group[0]);
    const providers = group
      .map((deal) => ({
        source: deal.source,
        provider: deal.provider,
        totalPrice: deal.totalPrice,
        nightlyPrice: deal.nightlyPrice,
        url: deal.url,
        priceVerified: deal.priceVerified === true,
      }))
      .sort((left, right) => left.totalPrice - right.totalPrice);
    const uniqueProviders = new Set(
      providers.map((provider) => provider.source || provider.provider),
    );
    const bestTotalPrice = Math.min(
      ...group.map((deal) => Number(deal.totalPrice) || Infinity),
    );
    for (const deal of group) {
      const totalPrice = Number(deal.totalPrice) || 0;
      const agreeingProviders = new Set(
        providers
          .filter((provider) => {
            const candidatePrice = Number(provider.totalPrice) || 0;
            if (totalPrice <= 0 || candidatePrice <= 0) return false;
            return Math.abs(candidatePrice - totalPrice) / totalPrice <= 0.08;
          })
          .map((provider) => provider.source || provider.provider),
      );
      const agreementBoost = agreeingProviders.size >= 2 ? 10 : 0;
      const marketScore = Number.isFinite(Number(deal.marketErrorFareScore))
        ? Number(deal.marketErrorFareScore)
        : Math.min(99, round(Number(deal.discountPercent || 0) * 1.35));
      const dropBoost = Math.min(
        15,
        round(Number(deal.priceDropPercent || 0) / 2),
      );
      const score = Math.min(
        99,
        marketScore + dropBoost + agreementBoost,
      );
      deal.comparisonGroupId = groupId;
      deal.providerCount = uniqueProviders.size;
      deal.agreeingProviderCount = agreeingProviders.size;
      deal.comparisonProviders = providers;
      deal.bestTotalPrice = bestTotalPrice;
      deal.isBestPrice = Number(deal.totalPrice) <= bestTotalPrice + 0.01;
      deal.marketErrorFareScore = marketScore;
      deal.preComparisonErrorFareScore = marketScore + dropBoost;
      deal.errorFareScore = score;
      classifyErrorFare(deal);
    }
  }
  return deals;
}

module.exports = {
  annotateMarketPrices,
  applyPriceDropIntelligence,
  classifyErrorFare,
  enrichDealComparisons,
  errorFareLevel,
  hotelNamesMatch,
  median,
  normalizeHotelName,
  scoreOffer,
};
