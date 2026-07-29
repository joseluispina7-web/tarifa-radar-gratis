const PANEL_URL =
  "https://joseluispina7-web.github.io/tarifa-radar-gratis/";
const MAX_ALERTS_PER_MESSAGE = 5;

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
    Number(offer.priceConfirmationCount) >= 2
      ? "<i>Precio reconfirmado en Booking antes del aviso</i>"
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAlertMessage(alerts, options = {}) {
  const panelUrl = options.panelUrl || PANEL_URL;
  const limited = [...(alerts || [])]
    .sort(
      (left, right) =>
        Number(left.offer?.totalPrice || Infinity) -
        Number(right.offer?.totalPrice || Infinity),
    )
    .slice(0, MAX_ALERTS_PER_MESSAGE);
  if (!limited.length) return "";

  const omitted = Math.max(0, alerts.length - limited.length);
  const heading =
    alerts.length === 1
      ? "<b>Tarifa Radar: 1 alerta</b>"
      : `<b>Tarifa Radar: ${alerts.length} alertas</b>`;
  const footer = [
    omitted ? `Hay ${omitted} ofertas más en el panel.` : "",
    `<a href="${escapeHtml(panelUrl)}">Abrir Tarifa Radar</a>`,
  ]
    .filter(Boolean)
    .join("\n");

  return [heading, ...limited.map(formatAlert), footer].join("\n\n");
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
    throw new Error(
      payload.description || `Telegram respondió ${response.status}.`,
    );
  }
  return payload.result;
}

async function sendAlertDigest(options) {
  const text = buildAlertMessage(options.alerts, {
    panelUrl: options.panelUrl,
  });
  if (!text) return { sent: false, reason: "no_alerts" };

  const result = await telegramRequest(
    options.token,
    "sendMessage",
    {
      chat_id: options.chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
    options,
  );
  return { sent: true, messageId: result.message_id };
}

module.exports = {
  MAX_ALERTS_PER_MESSAGE,
  PANEL_URL,
  buildAlertMessage,
  escapeHtml,
  formatAlert,
  formatDate,
  formatMoney,
  sendAlertDigest,
  telegramRequest,
};
