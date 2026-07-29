const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_ALERTS_PER_MESSAGE,
  buildAlertMessage,
  escapeHtml,
  sendAlertDigest,
} = require("../src/telegram.cjs");

function makeAlert(overrides = {}) {
  return {
    type: "new_match",
    monitorName: "Benidorm",
    previousPrice: 0,
    offer: {
      hotelName: "Hotel Sol & Mar",
      address: "Centro de Benidorm",
      checkIn: "2026-08-05",
      checkOut: "2026-08-09",
      nights: 4,
      totalPrice: 425.7,
      nightlyPrice: 106.43,
      stars: 0,
      guestRating: 8.7,
      distanceKm: 4.8,
      breakfastIncluded: true,
      priceVerified: true,
      priceConfirmationCount: 2,
      url: "https://www.booking.com/hotel/es/example.html?a=1&b=2",
      ...overrides.offer,
    },
    ...overrides,
  };
}

test("escapes user and hotel text for Telegram HTML", () => {
  assert.equal(
    escapeHtml('Hotel <Sol> & "Mar"'),
    "Hotel &lt;Sol&gt; &amp; &quot;Mar&quot;",
  );
  const message = buildAlertMessage([
    makeAlert({ offer: { hotelName: "A&B <Centro>" } }),
  ]);
  assert.match(message, /A&amp;B &lt;Centro&gt;/);
});

test("builds one compact verified Booking alert", () => {
  const message = buildAlertMessage([makeAlert()]);
  assert.match(message, /Tarifa Radar: 1 alerta/);
  assert.match(message, /425,7/);
  assert.match(message, /106,43/);
  assert.match(message, /Sin estrellas/);
  assert.match(message, /4,8 km del destino/);
  assert.match(message, /Precio confirmado en 2 ciclos de Booking/);
  assert.match(message, /Abrir Tarifa Radar/);
});

test("shows the former price for price drops", () => {
  const message = buildAlertMessage([
    makeAlert({ type: "price_drop", previousPrice: 499 }),
  ]);
  assert.match(message, /Bajada de precio/);
  assert.match(message, /<s>499/);
});

test("limits a digest and reports omitted offers", () => {
  const alerts = Array.from(
    { length: MAX_ALERTS_PER_MESSAGE + 2 },
    (_, index) =>
      makeAlert({
        offer: {
          hotelName: `Hotel ${index}`,
          totalPrice: 100 + index,
        },
      }),
  );
  const message = buildAlertMessage(alerts);
  assert.match(message, /7 alertas/);
  assert.match(message, /Hay 2 ofertas más en el panel/);
  assert.doesNotMatch(message, /Hotel 6/);
});

test("does not call Telegram when there are no alerts", async () => {
  let calls = 0;
  const result = await sendAlertDigest({
    alerts: [],
    token: "secret",
    chatId: "123",
    fetchImpl: async () => {
      calls += 1;
    },
  });
  assert.deepEqual(result, { sent: false, reason: "no_alerts" });
  assert.equal(calls, 0);
});

test("sends a digest with previews disabled", async () => {
  let request;
  const result = await sendAlertDigest({
    alerts: [makeAlert()],
    token: "secret",
    chatId: "123",
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 42 } }),
      };
    },
  });
  assert.equal(result.sent, true);
  assert.equal(result.messageId, 42);
  assert.equal(request.body.chat_id, "123");
  assert.equal(request.body.link_preview_options.is_disabled, true);
  assert.match(request.url, /botsecret\/sendMessage$/);
});
