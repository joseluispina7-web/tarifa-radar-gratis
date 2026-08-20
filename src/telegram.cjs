const { errorFareLevel } = require("./deal-intelligence.cjs");
const { exclusionActionId } = require("./hotel-exclusions.cjs");

const PANEL_URL =
  "https://joseluispina7-web.github.io/tarifa-radar-gratis/";
const MAX_ALERTS_PER_MESSAGE = 4;
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

function formatDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid",
  }).format(date);
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

function formatVerification(source, provider = "") {
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
    return `Precio revalidado por Bluepillow${provider ? `; proveedor ${provider}` : ""}. Confirma el total al abrir`;
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
    offer.distanceKm !== null &&
    offer.distanceKm !== undefined &&
    Number.isFinite(Number(offer.distanceKm))
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
  const score = Number(offer.errorFareScore) || 0;
  const discount = Number(offer.discountPercent) || 0;
  const signalLevel = offer.errorFareLevel || errorFareLevel(score, offer);
  const priceSignal = signalLevel === "probable_error"
    ? `🔥 <b>Posible tarifa error · ${score}/99</b>${
        discount > 0 ? ` · ${escapeHtml(`${discount}% bajo referencia`)}` : ""
      }`
    : signalLevel === "unusually_low"
      ? `📉 <b>Precio muy bajo · ${score}/99</b>${
          discount > 0 ? ` · ${escapeHtml(`${discount}% bajo referencia`)}` : ""
        }`
      : signalLevel === "good_price"
        ? `💡 Buen precio · ${score}/99`
        : "";
  const provider = offer.provider || source;
  const providerAgreement = Number(offer.providerCount) >= 2
    ? `🔎 ${offer.providerCount} proveedores comparados`
    : "";

  return [
    `<b>${alert.type === "price_drop" ? "📉" : "🏨"} ${type}</b>`,
    `<b>${hotel}</b>`,
    `📅 ${escapeHtml(stay)}`,
    `💶 <b>${escapeHtml(formatMoney(offer.totalPrice))} total</b> · ${escapeHtml(
      `${formatMoney(offer.nightlyPrice)}/noche`,
    )}${priceDrop}`,
    priceSignal,
    details ? `⭐ ${escapeHtml(details)}` : "",
    offer.address ? `📌 ${escapeHtml(offer.address)}` : "",
    providerAgreement,
    `<b>Fuente:</b> ${escapeHtml(provider)}${provider !== source ? ` · ${escapeHtml(source)}` : ""}`,
    Number(offer.priceConfirmationCount) >= 2
      ? `✅ <i>${escapeHtml(formatVerification(offer.source, provider))}</i>`
      : "",
    offer.priceProof?.verifiedAt || offer.priceConfirmedAt
      ? `🕒 Verificado ${escapeHtml(formatDateTime(
          offer.priceProof?.verifiedAt || offer.priceConfirmedAt,
        ))}${Number(offer.priceProof?.confirmationCount || offer.priceConfirmationCount) > 0
          ? ` · ${Number(offer.priceProof?.confirmationCount || offer.priceConfirmationCount)} lecturas`
          : ""}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function sortedAlerts(alerts) {
  return [...(alerts || [])].sort(
    (left, right) =>
      Number(right.offer?.errorFareScore || 0) -
        Number(left.offer?.errorFareScore || 0) ||
      Number(left.offer?.totalPrice || Infinity) -
        Number(right.offer?.totalPrice || Infinity),
  );
}

function alertLocationKey(alert) {
  return String(
    alert.monitorId ||
      alert.monitorName ||
      alert.offer?.searchArea ||
      alert.offer?.address ||
      "ubicacion",
  );
}

function groupAlertsByLocation(alerts) {
  const groups = new Map();
  for (const alert of sortedAlerts(alerts)) {
    const key = alertLocationKey(alert);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(alert);
  }
  return groups;
}

function buildAlertPages(alerts, options = {}) {
  const panelUrl = options.panelUrl || PANEL_URL;
  const groups = groupAlertsByLocation(alerts);
  if (!groups.size) return [];
  const messages = [];
  for (const group of groups.values()) {
    const pages = [];
    for (
      let index = 0;
      index < group.length;
      index += MAX_ALERTS_PER_MESSAGE
    ) {
      pages.push(group.slice(index, index + MAX_ALERTS_PER_MESSAGE));
    }
    for (const [index, page] of pages.entries()) {
      const location = page[0].monitorName || page[0].offer?.searchArea || "Ubicación";
      const pageText = pages.length > 1
        ? ` · ${index + 1}/${pages.length}`
        : "";
      const heading =
        `<b>📍 ${escapeHtml(location)}</b>\n` +
        `${group.length} ${group.length === 1 ? "alerta" : "alertas"}${pageText}`;
      const footer = `<a href="${escapeHtml(panelUrl)}">Abrir ofertas de ${escapeHtml(location)}</a>`;
      messages.push({
        text: [heading, ...page.map(formatAlert), footer].join("\n\n"),
        alerts: page,
        monitorId: String(page[0].monitorId || ""),
        monitorName: location,
      });
    }
  }
  return messages;
}

function buildAlertMessages(alerts, options = {}) {
  return buildAlertPages(alerts, options).map((page) => page.text);
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
  const pages = buildAlertPages(options.alerts, {
    panelUrl: options.panelUrl,
  });
  if (!pages.length) return { sent: false, reason: "no_alerts" };

  const sleepImpl = options.sleepImpl || sleep;
  const delayMs = options.delayMs ?? MESSAGE_DELAY_MS;
  const messageIds = [];
  for (const [index, page] of pages.entries()) {
    if (index > 0 && delayMs > 0) await sleepImpl(delayMs);
    const body = {
      chat_id: options.chatId,
      text: page.text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    };
    const buttons = page.alerts
      .map((alert) => {
        const row = [];
        if (alert.offer?.url) {
          row.push({
            text: `Abrir ${String(alert.offer.hotelName || "hotel").slice(0, 28)}`,
            url: alert.offer.url,
          });
        }
        if (alert.monitorId && alert.offer?.hotelName) {
          row.push({
            text: "Descartar",
            callback_data: `exclude:${exclusionActionId({
              monitorId: alert.monitorId,
              hotelName: alert.offer.hotelName,
            })}`,
          });
        }
        return row;
      })
      .filter((row) => row.length);
    if (page.monitorId && `mute:${page.monitorId}`.length <= 64) {
      buttons.push([{
        text: `Silenciar ${String(page.monitorName).slice(0, 42)}`,
        callback_data: `mute:${page.monitorId}`,
      }]);
    }
    if (buttons.length) body.reply_markup = { inline_keyboard: buttons };
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
  buildAlertPages,
  escapeHtml,
  formatAlert,
  formatDate,
  formatDateTime,
  formatMoney,
  formatSource,
  formatVerification,
  groupAlertsByLocation,
  sendAlertDigest,
  telegramRequest,
};
