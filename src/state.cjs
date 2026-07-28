function compareWithState(previous = {}, result) {
  const previousOffers = previous.offers || {};
  const changes = [];
  const nextOffers = { ...previousOffers };

  for (const offer of result.offers) {
    const before = previousOffers[offer.id];
    if (
      offer.matches &&
      (!before || !before.matches || offer.totalPrice < before.totalPrice)
    ) {
      changes.push({
        type: before ? "price_drop" : "new_match",
        previousPrice: before?.totalPrice || 0,
        offer,
      });
    }

    nextOffers[offer.id] = {
      hotelName: offer.hotelName,
      totalPrice: offer.totalPrice,
      nightlyPrice: offer.nightlyPrice,
      matches: offer.matches,
      firstSeenAt: before?.firstSeenAt || result.searchedAt,
      lastSeenAt: result.searchedAt,
    };
  }

  return {
    changes,
    state: {
      version: 1,
      searchId: result.search.id,
      updatedAt: result.searchedAt,
      offers: nextOffers,
    },
  };
}

module.exports = { compareWithState };
