const crypto = require("node:crypto");
const path = require("node:path");
const {
  newestRepositoryDocument,
  readJson,
  writeJson,
} = require("./repository-scan.cjs");
const {
  addHotelExclusion,
  exclusionActionId,
  hotelIsExcluded,
  normalizeExclusionsDocument,
} = require("./hotel-exclusions.cjs");
const {
  PANEL_URL,
  sendAlertDigest,
  telegramRequest,
} = require("./telegram.cjs");

const MAX_SENT_ALERTS = 1_000;
const SENT_ALERT_RETENTION_MS = 45 * 86_400_000;
const MAX_HOTEL_ACTIONS = 1_000;
const HOTEL_ACTION_RETENTION_MS = 180 * 86_400_000;

function normalizeFingerprintPart(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function alertFingerprint(alert) {
  const offer = alert.offer || {};
  return crypto
    .createHash("sha256")
    .update([
      normalizeFingerprintPart(alert.monitorId || alert.monitorName),
      normalizeFingerprintPart(offer.hotelName),
      normalizeFingerprintPart(offer.checkIn),
      normalizeFingerprintPart(offer.checkOut),
      Number(offer.totalPrice || 0).toFixed(2),
      normalizeFingerprintPart(offer.source),
    ].join("|"))
    .digest("hex")
    .slice(0, 24);
}

function mergeSentAlerts(...collections) {
  const byId = new Map();
  for (const collection of collections) {
    for (const entry of Array.isArray(collection) ? collection : []) {
      if (!entry?.id || !entry?.sentAt) continue;
      const current = byId.get(entry.id);
      if (!current || Date.parse(entry.sentAt) > Date.parse(current.sentAt)) {
        byId.set(entry.id, entry);
      }
    }
  }
  return Array.from(byId.values());
}

function pruneSentAlerts(entries, now = new Date()) {
  const threshold = now.getTime() - SENT_ALERT_RETENTION_MS;
  return mergeSentAlerts(entries)
    .filter((entry) => Date.parse(entry.sentAt) >= threshold)
    .sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt))
    .slice(-MAX_SENT_ALERTS);
}

async function readRemoteState(options = {}) {
  if (options.remoteState) return options.remoteState;
  const repository = options.repository || process.env.GITHUB_REPOSITORY;
  if (!repository) return null;
  const branch = options.branch || process.env.GITHUB_REF_NAME || "main";
  const fetchImpl = options.remoteFetchImpl || fetch;
  try {
    const response = await fetchImpl(
      `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(branch)}/state/repository-state.json?t=${Date.now()}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function readRemoteExclusions(options = {}) {
  if (options.remoteExclusions) return options.remoteExclusions;
  const repository = options.repository || process.env.GITHUB_REPOSITORY;
  if (!repository) return null;
  const branch = options.branch || process.env.GITHUB_REF_NAME || "main";
  const fetchImpl = options.remoteFetchImpl || fetch;
  try {
    const response = await fetchImpl(
      `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(branch)}/config/excluded-hotels.json?t=${Date.now()}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function pruneHotelActions(actions, now = new Date()) {
  const threshold = now.getTime() - HOTEL_ACTION_RETENTION_MS;
  return Object.fromEntries(
    Object.entries(actions || {})
      .filter(([, target]) =>
        target?.monitorId &&
        target?.hotelName &&
        Date.parse(target.registeredAt || "") >= threshold
      )
      .sort((left, right) =>
        Date.parse(left[1].registeredAt) - Date.parse(right[1].registeredAt)
      )
      .slice(-MAX_HOTEL_ACTIONS),
  );
}

function registerHotelActions(actions, alerts, registeredAt) {
  const next = { ...(actions || {}) };
  for (const alert of alerts || []) {
    if (!alert.monitorId || !alert.offer?.hotelName) continue;
    const id = exclusionActionId({
      monitorId: alert.monitorId,
      hotelName: alert.offer.hotelName,
    });
    next[id] = {
      monitorId: String(alert.monitorId),
      monitorName: String(alert.monitorName || "Busqueda"),
      hotelName: String(alert.offer.hotelName),
      source: String(alert.offer.source || ""),
      registeredAt,
    };
  }
  return next;
}

function monitorEntries(status) {
  return Object.entries(status.monitors || {}).map(([id, monitor]) => ({
    id: String(id),
    name: String(monitor.monitorName || id),
    status: monitor,
  }));
}

function findMonitor(status, query) {
  const normalized = normalizeFingerprintPart(query);
  if (!normalized) return null;
  const monitors = monitorEntries(status);
  return monitors.find((monitor) =>
    normalizeFingerprintPart(monitor.id) === normalized ||
    normalizeFingerprintPart(monitor.name) === normalized
  ) || monitors.find((monitor) =>
    normalizeFingerprintPart(monitor.name).includes(normalized)
  );
}

function botStatusMessage(status, mutedMonitorIds = [], excludedCount = 0) {
  const summary = status.summary || {};
  const health = status.health || summary.health || {};
  const monitors = monitorEntries(status);
  const pausedSources = monitors.reduce(
    (count, monitor) => count + Object.values(monitor.status.sources || {})
      .filter((source) => source.state === "paused").length,
    0,
  );
  return [
    "Tarifa Radar",
    `Estado: ${health.state === "partial" ? "ciclo parcial" : health.state === "degraded" ? "degradado" : "operativo"}`,
    `Último ciclo: ${status.updatedAt || "sin datos"}`,
    `Búsquedas: ${Number(summary.searches) || 0} · precios: ${Number(summary.offers) || 0} · coincidencias: ${Number(summary.matches) || 0}`,
    `Ubicaciones: ${monitors.length} · fuentes pausadas: ${pausedSources}`,
    `Ubicaciones silenciadas: ${mutedMonitorIds.length}`,
    `Hoteles descartados: ${excludedCount}`,
    PANEL_URL,
  ].join("\n");
}

async function processTelegramUpdates(options) {
  const telegramState = { ...(options.telegramState || {}) };
  const exclusions = options.exclusions || { version: 1, hotels: [] };
  const muted = new Set(
    Array.isArray(telegramState.mutedMonitorIds)
      ? telegramState.mutedMonitorIds.map(String)
      : [],
  );
  let updates;
  try {
    updates = await telegramRequest(
      options.token,
      "getUpdates",
      {
        offset: Number(telegramState.updateOffset) || 0,
        limit: 100,
        timeout: 0,
        allowed_updates: ["message", "callback_query"],
      },
      { fetchImpl: options.fetchImpl, timeoutMs: 10_000 },
    );
  } catch (error) {
    return {
      ...telegramState,
      mutedMonitorIds: Array.from(muted),
      updateError: error instanceof Error ? error.message : String(error),
    };
  }
  if (!Array.isArray(updates)) return telegramState;

  let updateError = "";
  const sendReply = (text) => telegramRequest(
    options.token,
    "sendMessage",
    { chat_id: options.chatId, text, link_preview_options: { is_disabled: true } },
    { fetchImpl: options.fetchImpl },
  );
  for (const update of updates) {
    telegramState.updateOffset = Math.max(
      Number(telegramState.updateOffset) || 0,
      Number(update.update_id) + 1,
    );
    const callback = update.callback_query;
    const message = update.message;
    const updateChatId = callback?.message?.chat?.id ?? message?.chat?.id;
    if (String(updateChatId) !== String(options.chatId)) continue;

    try {
      if (callback) {
        const [action, value] = String(callback.data || "").split(":", 2);
        const monitorId = value;
        const monitor = monitorEntries(options.status)
          .find((entry) => entry.id === String(monitorId));
        if (action === "mute" && monitor) muted.add(monitor.id);
        if (action === "unmute" && monitor) muted.delete(monitor.id);
        let callbackText = monitor
          ? `${monitor.name}: ${muted.has(monitor.id) ? "silenciada" : "activa"}`
          : "Búsqueda no encontrada";
        if (action === "exclude") {
          const target = telegramState.hotelActions?.[value];
          if (target) {
            const result = addHotelExclusion(
              exclusions,
              { ...target, origin: "telegram" },
              options.now || new Date(),
            );
            Object.assign(exclusions, result.document);
            callbackText = result.added
              ? `${target.hotelName}: descartado. Puedes restaurarlo en el panel.`
              : `${target.hotelName}: ya estaba descartado.`;
          } else {
            callbackText = "Este botón ha caducado. Puedes descartarlo desde una alerta nueva.";
          }
        }
        await telegramRequest(
          options.token,
          "answerCallbackQuery",
          {
            callback_query_id: callback.id,
            text: callbackText.slice(0, 190),
          },
          { fetchImpl: options.fetchImpl },
        );
        continue;
      }

      const text = String(message?.text || "").trim();
      const [rawCommand, ...argumentParts] = text.split(/\s+/);
      const command = rawCommand.toLowerCase().split("@")[0];
      const argument = argumentParts.join(" ");
      if (command === "/estado") {
        await sendReply(botStatusMessage(
          options.status,
          Array.from(muted),
          normalizeExclusionsDocument(exclusions).hotels.length,
        ));
      } else if (command === "/ayuda" || command === "/start") {
        await sendReply([
          "Comandos de Tarifa Radar:",
          "/estado",
          "/silenciar Nombre de la búsqueda",
          "/activar Nombre de la búsqueda",
          "/silenciadas",
          "/descartados",
        ].join("\n"));
      } else if (command === "/silenciadas") {
        const names = monitorEntries(options.status)
          .filter((monitor) => muted.has(monitor.id))
          .map((monitor) => monitor.name);
        await sendReply(names.length
          ? `Silenciadas:\n${names.join("\n")}`
          : "No hay ubicaciones silenciadas.");
      } else if (command === "/descartados") {
        const hotels = normalizeExclusionsDocument(exclusions).hotels;
        await sendReply(hotels.length
          ? `Hoteles descartados:\n${hotels
              .slice(-30)
              .map((entry) => `${entry.hotelName} (${entry.monitorName})`)
              .join("\n")}\n\nPuedes restaurarlos desde el panel.`
          : "No hay hoteles descartados.");
      } else if (command === "/silenciar" || command === "/activar") {
        const monitor = findMonitor(options.status, argument);
        if (!monitor) {
          await sendReply("No encuentro esa búsqueda. Usa el nombre que aparece en el panel.");
        } else {
          if (command === "/silenciar") muted.add(monitor.id);
          else muted.delete(monitor.id);
          await sendReply(
            `${monitor.name}: ${command === "/silenciar" ? "silenciada" : "activada"}.`,
          );
        }
      }
    } catch (error) {
      updateError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ...telegramState,
    mutedMonitorIds: Array.from(muted),
    updateError,
  };
}

async function sendRepositoryAlerts(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const token = options.token || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { sent: false, reason: "not_configured" };
  }

  const status = readJson(
    path.resolve(root, options.statusPath || "docs/data/status.json"),
    { alerts: [] },
  );
  const statePath = path.resolve(
    root,
    options.statePath || "state/repository-state.json",
  );
  const exclusionsPath = path.resolve(
    root,
    options.exclusionsPath || "config/excluded-hotels.json",
  );
  const repositoryState = readJson(statePath, { version: 1, monitors: {} });
  const remoteState = await readRemoteState(options);
  const localExclusions = readJson(exclusionsPath, {
    version: 1,
    updatedAt: "",
    hotels: [],
  });
  const remoteExclusions = await readRemoteExclusions(options);
  const exclusions = normalizeExclusionsDocument(newestRepositoryDocument(
    localExclusions,
    remoteExclusions,
  ));
  const now = options.now || new Date();
  let telegramState = {
    ...(remoteState?.telegram || {}),
    ...(repositoryState.telegram || {}),
    mutedMonitorIds: Array.from(new Set([
      ...(repositoryState.telegram?.mutedMonitorIds || []),
      ...(remoteState?.telegram?.mutedMonitorIds || []),
    ].map(String))),
    updateOffset: Math.max(
      Number(remoteState?.telegram?.updateOffset) || 0,
      Number(repositoryState.telegram?.updateOffset) || 0,
    ),
    hotelActions: pruneHotelActions({
      ...(remoteState?.telegram?.hotelActions || {}),
      ...(repositoryState.telegram?.hotelActions || {}),
    }, now),
  };
  if (options.processUpdates !== false) {
    try {
      telegramState = await processTelegramUpdates({
        telegramState,
        status,
        token,
        chatId,
        fetchImpl: options.fetchImpl,
        exclusions,
        now,
      });
    } catch (error) {
      telegramState.updateError = error instanceof Error
        ? error.message
        : String(error);
    }
  }
  const sentAlerts = pruneSentAlerts(
    mergeSentAlerts(
      repositoryState.telegram?.sentAlerts,
      remoteState?.telegram?.sentAlerts,
    ),
    now,
  );
  const sentIds = new Set(sentAlerts.map((entry) => entry.id));
  const mutedIds = new Set(
    (telegramState.mutedMonitorIds || []).map(String),
  );
  const batchIds = new Set();
  const newAlerts = (status.alerts || []).filter((alert) => {
    if (mutedIds.has(String(alert.monitorId))) return false;
    if (hotelIsExcluded(
      exclusions,
      alert.monitorId,
      alert.offer?.hotelName,
    )) return false;
    const id = alertFingerprint(alert);
    if (sentIds.has(id) || batchIds.has(id)) return false;
    batchIds.add(id);
    return true;
  });
  const persistTelegramState = (nextSentAlerts) => {
    repositoryState.telegram = {
      ...telegramState,
      sentAlerts: pruneSentAlerts(nextSentAlerts, now),
    };
    writeJson(statePath, repositoryState);
    writeJson(exclusionsPath, exclusions);
  };
  persistTelegramState(sentAlerts);
  if (!newAlerts.length) {
    return {
      sent: false,
      reason: "no_alerts",
      duplicatesSkipped: (status.alerts || []).length,
    };
  }

  const result = await sendAlertDigest({
    alerts: newAlerts,
    token,
    chatId,
    panelUrl: options.panelUrl,
    fetchImpl: options.fetchImpl,
  });
  if (result.sent) {
    const sentAt = now.toISOString();
    telegramState.hotelActions = pruneHotelActions(registerHotelActions(
      telegramState.hotelActions,
      newAlerts,
      sentAt,
    ), now);
    persistTelegramState([
      ...sentAlerts,
      ...newAlerts.map((alert) => ({
        id: alertFingerprint(alert),
        sentAt,
      })),
    ]);
  }
  return {
    ...result,
    duplicatesSkipped: (status.alerts || []).length - newAlerts.length,
  };
}

if (require.main === module) {
  sendRepositoryAlerts()
    .then((result) => {
      if (result.reason === "not_configured") {
        process.stdout.write(
          "Telegram no está configurado; se omiten las alertas.\n",
        );
      } else if (result.reason === "no_alerts") {
        process.stdout.write("No hay alertas nuevas para Telegram.\n");
      } else {
        process.stdout.write(
          `${result.alertsSent} alertas enviadas en ${result.messageCount} mensajes de Telegram.\n`,
        );
      }
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

module.exports = {
  alertFingerprint,
  botStatusMessage,
  findMonitor,
  mergeSentAlerts,
  pruneHotelActions,
  pruneSentAlerts,
  processTelegramUpdates,
  readRemoteExclusions,
  readRemoteState,
  registerHotelActions,
  sendRepositoryAlerts,
};
