const PANEL_URL =
  "https://joseluispina7-web.github.io/tarifa-radar-gratis/";
const MAX_ALERTS_PER_MESSAGE = 5;
const MESSAGE_DELAY_MS = 1_100;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatMoney(value) {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function formatDate(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return escapeHtml(value);
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
  })
    .format(new Date(Date.UTC(year, month - 1, day)))
    .replace(".", "");
}

function formatStars(stars) {
  const value = Number(stars) || 0;
  return value > 0
    ? `${value} ${value === 1 ? "estrella" : "estrellas"}`
    : "Sin estrellas";
}

function formatSource(source) {
  return {
    booking: "Booking",
    google_hotels: "Google Hotels",
    agoda: "Agoda",
    trip: "Trip.com",
    bluepillow: "Bluepillow",
  }[source] || source;
}

function formatVerification(source) {
  if (source === "booking") {
    return "Precio reconfirmado en Booking antes del aviso";
  }
  if (source === "google_hotels") {
    return "Total con impuestos y tasas leido en Google Hotels";
  }
  if (source === "trip") {
    return "Total final leido directamente en Trip.com antes del aviso";
  }
  if (["agoda", "bluepillow"].includes(source)) {
    return `Precio de comparador revalidado en ${formatSource(source)} via Bluepillow; confirma el total al abrir`;
  }
  return "Precio verificado antes del aviso";
}

function formatAlert(alert) {
  const offer = alert.offer || {};
  const type =
    alert.type === "price_drop" ? "Bajada de precio" : "Nueva oferta";
  const stay = [
    `${formatDate(offer.checkIn)} - ${formatDate(offer.checkOut)}`,
    offer.nights
      ? `${offer.nights} ${offer.nights === 1 ? "noche" : "noches"}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const details = [
    formatStars(offer.stars),
    offer.guestRating
      ? `Nota ${Number(offer.guestRating).toLocaleString("es-ES")}`
      : "",
    Number(offer.distanceKm) > 0
      ? `${Number(offer.distanceKm).toLocaleString("es-ES")} km del destino`
      : "",
    offer.breakfastIncluded ? "Desayuno incluido" : "",
    offer.freeCancellation ? "Cancelación gratis" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const priceDrop =
    alert.type === "price_drop" && Number(alert.previousPrice) > 0
      ? `\nAntes: <s>${escapeHtml(formatMoney(alert.previousPrice))}</s>`
      : "";
  const hotelName = escapeHtml(offer.hotelName || "Hotel");
  const source = formatSource(offer.source);
  const hotel = offer.url
    ? `<a href="${escapeHtml(offer.url)}">${hotelName}</a>`
    : hotelName;

  return [
    `<b>${type}</b>`,
    hotel,
    escapeHtml(
      [alert.monitorName, offer.address].filter(Boolean).join(" · "),
    ),
    escapeHtml(stay),
    `<b>${escapeHtml(formatMoney(offer.totalPrice))} total</b> · ${escapeHtml(
      `${formatMoney(offer.nightlyPrice)}/noche`,
    )}${priceDrop}`,
    escapeHtml(details),
    `<b>Fuente:</b> ${escapeHtml(source)}`,
    Number(offer.priceConfirmationCount) >= 2
      ? `<i>${escapeHtml(formatVerification(offer.source))}</i>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function sortedAlerts(alerts) {
  return [...(alerts || [])].sort(
    (left, right) =>
      Number(left.offer?.totalPrice || Infinity) -
      Number(right.offer?.totalPrice || Infinity),
  );
}

function buildAlertMessages(alerts, options = {}) {
  const panelUrl = options.panelUrl || PANEL_URL;
  const ordered = sortedAlerts(alerts);
  if (!ordered.length) return [];

  const pages = [];
  for (
    let index = 0;
    index < ordered.length;
    index += MAX_ALERTS_PER_MESSAGE
  ) {
    pages.push(ordered.slice(index, index + MAX_ALERTS_PER_MESSAGE));
  }

  return pages.map((page, index) => {
    const pageText = pages.length > 1
      ? ` (${index + 1}/${pages.length})`
      : "";
    const heading =
      ordered.length === 1
        ? "<b>Tarifa Radar: 1 alerta</b>"
        : `<b>Tarifa Radar: ${ordered.length} alertas${pageText}</b>`;
    const footer =
      `<a href="${escapeHtml(panelUrl)}">Abrir Tarifa Radar</a>`;
    return [heading, ...page.map(formatAlert), footer].join("\n\n");
  });
}

function buildAlertMessage(alerts, options = {}) {
  return buildAlertMessages(alerts, options)[0] || "";
}

async function telegramRequest(token, method, body, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs || 15_000),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    const error = new Error(
      payload.description || `Telegram respondió ${response.status}.`,
    );
    error.retryAfter = Number(payload.parameters?.retry_after) || 0;
    throw error;
  }
  return payload.result;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sendAlertDigest(options) {
  const messages = buildAlertMessages(options.alerts, {
    panelUrl: options.panelUrl,
  });
  if (!messages.length) return { sent: false, reason: "no_alerts" };

  const sleepImpl = options.sleepImpl || sleep;
  const delayMs = options.delayMs ?? MESSAGE_DELAY_MS;
  const messageIds = [];
  for (const [index, text] of messages.entries()) {
    if (index > 0 && delayMs > 0) await sleepImpl(delayMs);
    const body = {
      chat_id: options.chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    };
    let result;
    try {
      result = await telegramRequest(
        options.token,
        "sendMessage",
        body,
        options,
      );
    } catch (error) {
      if (!error.retryAfter) throw error;
      await sleepImpl((error.retryAfter + 1) * 1_000);
      result = await telegramRequest(
        options.token,
        "sendMessage",
        body,
        options,
      );
    }
    messageIds.push(result.message_id);
  }
  return {
    sent: true,
    messageId: messageIds[0],
    messageIds,
    messageCount: messageIds.length,
    alertsSent: options.alerts.length,
  };
}

module.exports = {
  MAX_ALERTS_PER_MESSAGE,
  MESSAGE_DELAY_MS,
  PANEL_URL,
  buildAlertMessage,
  buildAlertMessages,
  escapeHtml,
  formatAlert,
  formatDate,
  formatMoney,
  formatSource,
  formatVerification,
  sendAlertDigest,
  telegramRequest,
};
