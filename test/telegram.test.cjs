const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_ALERTS_PER_MESSAGE,
  buildAlertMessage,
  buildAlertMessages,
  escapeHtml,
  groupAlertsByLocation,
  sendAlertDigest,
} = require("../src/telegram.cjs");

function makeAlert(overrides = {}) {
  return {
    type: "new_match",
    monitorId: "benidorm",
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
      source: "booking",
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
  assert.match(message, /📍 Benidorm/);
  assert.match(message, /1 alerta/);
  assert.match(message, /425,7/);
  assert.match(message, /106,43/);
  assert.match(message, /Sin estrellas/);
  assert.match(message, /4,8 km del destino/);
  assert.match(message, /Precio reconfirmado en Booking antes del aviso/);
  assert.match(message, /Abrir ofertas de Benidorm/);
});

test("shows the former price for price drops", () => {
  const message = buildAlertMessage([
    makeAlert({ type: "price_drop", previousPrice: 499 }),
  ]);
  assert.match(message, /Bajada de precio/);
  assert.match(message, /<s>499/);
});

test("labels Google Hotels alerts without claiming Booking verification", () => {
  const message = buildAlertMessage([
    makeAlert({
      offer: {
        source: "google_hotels",
        priceConfirmationCount: 2,
        url: "https://www.google.com/travel/search?qs=hotel",
      },
    }),
  ]);
  assert.match(message, /Fuente:<\/b> Google Hotels/);
  assert.match(message, /Total con impuestos y tasas leido en Google Hotels/);
  assert.doesNotMatch(message, /reconfirmado en Booking/);
});

test("labels Agoda alerts as prices supplied through Bluepillow", () => {
  const message = buildAlertMessage([
    makeAlert({
      offer: {
        source: "agoda",
        provider: "Agoda via Bluepillow",
        priceConfirmationCount: 2,
        url: "https://www.bluepillow.com/skippy?connectorname=Agoda",
      },
    }),
  ]);
  assert.match(message, /Fuente:<\/b> Agoda/);
  assert.match(message, /revalidado por Bluepillow; proveedor Agoda via Bluepillow/);
  assert.doesNotMatch(message, /reconfirmado en Booking/);
});

test("splits a digest into pages without omitting offers", () => {
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
  const messages = buildAlertMessages(alerts);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /6 alertas · 1\/2/);
  assert.match(messages[1], /6 alertas · 2\/2/);
  assert.doesNotMatch(messages.join("\n"), /ofertas más en el panel/);
  for (let index = 0; index < alerts.length; index += 1) {
    assert.match(messages.join("\n"), new RegExp(`Hotel ${index}`));
  }
  assert.equal(messages.every((message) => message.length < 4_096), true);
});

test("keeps Telegram messages separated by location", () => {
  const alerts = [
    makeAlert({ monitorId: "benidorm", monitorName: "Benidorm" }),
    makeAlert({
      monitorId: "madrid",
      monitorName: "Madrid",
      offer: { hotelName: "Hotel Madrid", totalPrice: 150 },
    }),
  ];
  const groups = groupAlertsByLocation(alerts);
  const messages = buildAlertMessages(alerts);
  assert.equal(groups.size, 2);
  assert.equal(messages.length, 2);
  const benidormMessage = messages.find((message) => /📍 Benidorm/.test(message));
  const madridMessage = messages.find((message) => /📍 Madrid/.test(message));
  assert.ok(benidormMessage);
  assert.ok(madridMessage);
  assert.doesNotMatch(benidormMessage, /Hotel Madrid/);
});

test("puts likely error fares first within one location", () => {
  const message = buildAlertMessage([
    makeAlert({ offer: { hotelName: "Precio normal", totalPrice: 100 } }),
    makeAlert({
      offer: {
        hotelName: "Tarifa error",
        totalPrice: 180,
        errorFareScore: 88,
        errorFareLevel: "probable_error",
        discountPercent: 54,
      },
    }),
  ]);
  assert.ok(message.indexOf("Tarifa error") < message.indexOf("Precio normal"));
  assert.match(message, /Posible tarifa error · 88\/99/);
  assert.match(message, /54% bajo referencia/);
});

test("does not call a high score an error fare without the required evidence", () => {
  const message = buildAlertMessage([
    makeAlert({
      offer: {
        hotelName: "Precio llamativo",
        totalPrice: 180,
        errorFareScore: 88,
        errorFareLevel: "unusually_low",
        discountPercent: 54,
      },
    }),
  ]);
  assert.match(message, /Precio muy bajo/);
  assert.doesNotMatch(message, /Posible tarifa error/);
});

test("labels Trip.com alerts as directly verified", () => {
  const message = buildAlertMessage([
    makeAlert({
      offer: {
        source: "trip",
        provider: "Trip.com",
        priceConfirmationCount: 2,
        url: "https://us.trip.com/hotels/list/searchresults",
      },
    }),
  ]);
  assert.match(message, /Fuente:<\/b> Trip.com/);
  assert.match(message, /Total final leido directamente en Trip.com/);
  assert.doesNotMatch(message, /via Bluepillow/);
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
  assert.equal(request.body.reply_markup.inline_keyboard.length, 2);
  assert.match(
    request.body.reply_markup.inline_keyboard[0][0].url,
    /booking\.com/,
  );
  assert.match(
    request.body.reply_markup.inline_keyboard[1][0].callback_data,
    /^mute:/,
  );
  assert.match(request.url, /botsecret\/sendMessage$/);
});

test("sends every alert across multiple Telegram messages", async () => {
  const alerts = Array.from(
    { length: MAX_ALERTS_PER_MESSAGE * 2 + 1 },
    (_, index) =>
      makeAlert({
        offer: {
          hotelName: `Hotel completo ${index}`,
          totalPrice: 100 + index,
        },
      }),
  );
  const requests = [];
  const result = await sendAlertDigest({
    alerts,
    token: "secret",
    chatId: "123",
    delayMs: 0,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: requests.length },
        }),
      };
    },
  });

  assert.equal(result.sent, true);
  assert.equal(result.alertsSent, alerts.length);
  assert.equal(result.messageCount, 3);
  assert.deepEqual(result.messageIds, [1, 2, 3]);
  assert.equal(requests.length, 3);
  const sentText = requests.map((request) => request.body.text).join("\n");
  for (let index = 0; index < alerts.length; index += 1) {
    assert.match(sentText, new RegExp(`Hotel completo ${index}`));
  }
});

test("waits and retries a Telegram rate-limit response", async () => {
  let calls = 0;
  const waits = [];
  const result = await sendAlertDigest({
    alerts: [makeAlert()],
    token: "secret",
    chatId: "123",
    sleepImpl: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({
            ok: false,
            description: "Too Many Requests",
            parameters: { retry_after: 1 },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 9 } }),
      };
    },
  });

  assert.equal(result.sent, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2_000]);
});
