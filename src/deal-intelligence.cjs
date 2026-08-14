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

function errorFareLevel(score) {
  const value = Number(score) || 0;
  if (value >= 75) return "probable_error";
  if (value >= 55) return "unusually_low";
  if (value >= 30) return "good_price";
  return "normal";
}

function scoreOffer(offer, marketMedianNightly, sampleSize) {
  const nightlyPrice = Number(offer.nightlyPrice) || 0;
  const hasMarketReference =
    sampleSize >= 5 && marketMedianNightly > 0 && nightlyPrice > 0;
  const discountPercent = hasMarketReference && nightlyPrice < marketMedianNightly
    ? round((1 - nightlyPrice / marketMedianNightly) * 100, 1)
    : 0;
  const verificationBoost =
    offer.priceVerified === true && Number(offer.priceConfirmationCount) >= 2
      ? 10
      : 0;
  const baseScore = Math.min(
    99,
    Math.max(0, round(discountPercent * 1.45 + verificationBoost)),
  );
  return {
    marketMedianNightly: hasMarketReference
      ? round(marketMedianNightly, 2)
      : 0,
    marketSampleSize: hasMarketReference ? sampleSize : 0,
    discountPercent,
    errorFareScore: baseScore,
    errorFareLevel: errorFareLevel(baseScore),
  };
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
    Object.assign(
      offer,
      scoreOffer(offer, marketMedianNightly, usable.length),
    );
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
    Number(offer.errorFareScore || 0) + Math.min(15, round(priceDropPercent / 2)),
  );
  offer.priceDropPercent = priceDropPercent;
  offer.errorFareScore = score;
  offer.errorFareLevel = errorFareLevel(score);
  return offer;
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
    const agreementBoost = uniqueProviders.size >= 2 ? 10 : 0;
    for (const deal of group) {
      const score = Math.min(
        99,
        Number(deal.errorFareScore || 0) + agreementBoost,
      );
      deal.comparisonGroupId = groupId;
      deal.providerCount = uniqueProviders.size;
      deal.comparisonProviders = providers;
      deal.bestTotalPrice = bestTotalPrice;
      deal.isBestPrice = Number(deal.totalPrice) <= bestTotalPrice + 0.01;
      deal.errorFareScore = score;
      deal.errorFareLevel = errorFareLevel(score);
    }
  }
  return deals;
}

module.exports = {
  annotateMarketPrices,
  applyPriceDropIntelligence,
  enrichDealComparisons,
  errorFareLevel,
  hotelNamesMatch,
  median,
  normalizeHotelName,
  scoreOffer,
};
