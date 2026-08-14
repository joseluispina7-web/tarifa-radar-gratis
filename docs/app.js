(() => {
  "use strict";

  const OWNER = "joseluispina7-web";
  const REPO = "tarifa-radar-gratis";
  const BRANCH = "main";
  const CONFIG_PATH = "config/searches.json";
  const STATUS_PATH = "docs/data/status.json";
  const DEALS_PATH = "docs/data/deals.json";
  const ACCESS_KEY_STORAGE = "tarifa-radar-panel-key";
  const LOCATION_CACHE_STORAGE = "tarifa-radar-location-cache-v1";
  const LOCATION_SUGGESTION_CACHE_STORAGE =
    "tarifa-radar-location-suggestions-v1";
  const SUGGESTION_GEOCODER_URL = "https://photon.komoot.io/api/";
  const DETAILED_GEOCODER_URL =
    "https://nominatim.openstreetmap.org/search";
  const {
    locationTypeLabel,
    mergeLocationResults,
    normalizeNominatimLocation,
    normalizeOpenMeteoLocation,
    normalizePhotonLocation,
  } = window.TarifaLocationSearch;
  const TOKEN_VAULT = {
    salt: "JVjEw2MYf1z15nqoGYMyAQ==",
    iv: "bTZ51FpHrrHWjWC9",
    ciphertext:
      "metpSPyAb7GcM3x8P/wFLwxr0OS47BPxI8qZcVwwnNQHS/WN0kSZ/2M1i3hEO0ZnZEeAKtddSSM3hqzVjjPJzKv4tKP11zeyuIt4VJ5C+kOVPo4pmtZ2vI2kdCPIgQ+BvUv/TP5D5pQjR53ACg==",
    iterations: 250000,
  };

  const propertyOptions = [
    ["hotel", "Hotel"],
    ["apartment", "Apartamento"],
    ["resort", "Resort"],
    ["rural", "Casa rural"],
    ["hostel", "Hostal"],
  ];
  const amenityOptions = [
    ["pool", "Piscina"],
    ["spa", "Spa"],
    ["parking", "Parking"],
    ["beach", "Junto a la playa"],
    ["breakfast", "Desayuno"],
    ["pets", "Admite mascotas"],
    ["air_conditioning", "Aire acondicionado"],
    ["family_rooms", "Habitaciones familiares"],
    ["all_inclusive", "Todo incluido"],
    ["gym", "Gimnasio"],
  ];
  const sources = [
    ["booking", "Booking", true, "Precio directo", "strict"],
    [
      "google_hotels",
      "Google Hotels",
      true,
      "Totales de varios proveedores",
      "strict",
    ],
    ["agoda", "Agoda", true, "Comparador via Bluepillow", "comparison"],
    ["trip", "Trip.com", true, "Total confirmado en Trip.com", "strict"],
    ["bluepillow", "Bluepillow", true, "Precio orientativo", "comparison"],
  ];

  const state = {
    accessKey: localStorage.getItem(ACCESS_KEY_STORAGE) || "",
    token: "",
    config: { version: 1, monitors: [] },
    status: { summary: {}, monitors: {}, alerts: [] },
    deals: { deals: [] },
    selectedId: null,
    draft: null,
    view: "monitors",
    locationResults: [],
    locationTimer: null,
    locationRequest: 0,
    locationSearchBusy: false,
    lastDetailedLocationRequestAt: 0,
    locationContext: null,
    locationAbortController: null,
    dealMonitorFilter: "all",
  };
  let resultsRefreshPending = false;
  let autoRefreshTimer = null;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.toString() : "#";
    } catch {
      return "#";
    }
  }

  function createId() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : `monitor-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function addDays(date, days) {
    const copy = new Date(date.getTime());
    copy.setDate(copy.getDate() + days);
    return copy;
  }

  function isoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function defaultMonitor() {
    const start = addDays(new Date(), 30);
    return {
      id: createId(),
      name: "España · 4 noches",
      location: "España",
      locationId: "2510769",
      latitude: 40,
      longitude: -4,
      countryCode: "ES",
      locationType: "country",
      locationCity: "",
      locationRadiusKm: 0,
      dateMode: "flexible",
      dateStart: isoDate(start),
      dateEnd: isoDate(addDays(start, 4)),
      windowDays: 180,
      minNights: 4,
      maxNights: 7,
      maxTotal: 150,
      maxNightly: 30,
      priceMatch: "any",
      priceSafetyPercent: 5,
      minStars: 0,
      guestRatingMin: 0,
      maxDistanceKm: 0,
      freeCancellation: false,
      mealPlan: "any",
      propertyTypes: [],
      amenities: [],
      adults: 2,
      children: 0,
      rooms: 1,
      intervalMinutes: 5,
      sources: ["booking"],
      strictPrices: true,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function toBase64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  function fromBase64(value) {
    const binary = atob(String(value).replace(/\n/g, ""));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  }

  function base64Bytes(value) {
    return Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
  }

  async function decryptPanelToken(accessKey) {
    const encoder = new TextEncoder();
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(accessKey),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: base64Bytes(TOKEN_VAULT.salt),
        iterations: TOKEN_VAULT.iterations,
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64Bytes(TOKEN_VAULT.iv),
      },
      key,
      base64Bytes(TOKEN_VAULT.ciphertext),
    );
    return new TextDecoder().decode(decrypted);
  }

  async function apiFetch(pathname, options = {}) {
    const response = await fetch(`https://api.github.com${pathname}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${state.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || `GitHub respondió ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function getFile(pathname, fallback) {
    try {
      const payload = await apiFetch(
        `/repos/${OWNER}/${REPO}/contents/${pathname}?ref=${BRANCH}&t=${Date.now()}`,
      );
      return {
        value: JSON.parse(fromBase64(payload.content)),
        sha: payload.sha,
      };
    } catch (error) {
      if (error.status === 404 && fallback !== undefined) {
        return { value: fallback, sha: null };
      }
      throw error;
    }
  }

  async function saveConfig(config) {
    const current = await getFile(CONFIG_PATH, { version: 1, monitors: [] });
    const body = {
      message: "Actualizar búsquedas desde Tarifa Radar",
      content: toBase64(`${JSON.stringify(config, null, 2)}\n`),
      branch: BRANCH,
    };
    if (current.sha) body.sha = current.sha;
    await apiFetch(`/repos/${OWNER}/${REPO}/contents/${CONFIG_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function setBusy(busy) {
    $("#loading-line").classList.toggle("hidden", !busy);
    $("#refresh-button").disabled = busy;
  }

  let toastTimer;
  function showToast(message) {
    clearTimeout(toastTimer);
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 3500);
  }

  function refreshIcons() {
    if (window.lucide) {
      window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
    }
  }

  function formatDateTime(value) {
    if (!value) return "Sin ejecutar";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Sin ejecutar";
    return new Intl.DateTimeFormat("es-ES", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(date);
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(`${value}T12:00:00`);
    return new Intl.DateTimeFormat("es-ES", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(date);
  }

  function nightsBetween(start, end) {
    const first = Date.parse(`${start}T12:00:00Z`);
    const last = Date.parse(`${end}T12:00:00Z`);
    return Math.round((last - first) / 86_400_000);
  }

  function renderConnectionState() {
    const updatedAt = state.status.updatedAt;
    const age = updatedAt ? Date.now() - Date.parse(updatedAt) : Infinity;
    const online = age < 30 * 60_000;
    const configChangedAt = Date.parse(state.config.updatedAt || "");
    const scanStartedAt = Date.parse(
      state.status.summary?.generatedAt || updatedAt || "",
    );
    const pendingConfig =
      Number.isFinite(configChangedAt) &&
      (!Number.isFinite(scanStartedAt) || configChangedAt > scanStartedAt);
    $("#scanner-dot").classList.toggle("online", online || pendingConfig);
    $("#scanner-label").textContent = pendingConfig
      ? "Cambio pendiente"
      : online
        ? "Escáner activo"
        : "Esperando ciclo";
    $("#scanner-time").textContent = pendingConfig
      ? "Buscando con los filtros nuevos"
      : updatedAt
        ? formatDateTime(updatedAt)
        : "GitHub Actions";
    $("#sync-badge").classList.add("ready");
    $("#sync-badge").innerHTML = pendingConfig
      ? '<i data-lucide="clock-3"></i> Actualizando'
      : '<i data-lucide="cloud"></i> Sincronizado';
    $("#github-status").textContent = updatedAt
      ? `Último ciclo: ${formatDateTime(updatedAt)}.`
      : "Escáner gratuito programado.";
    renderSourceHealthSummary();
  }

  function renderSourceHealthSummary() {
    const container = $("#source-health-list");
    if (!container) return;
    const monitorStatuses = Object.values(state.status.monitors || {});
    container.innerHTML = sources
      .filter(([, , automatic]) => automatic)
      .map(([source, label]) => {
        const values = monitorStatuses
          .map((monitor) => monitor.sources?.[source])
          .filter(Boolean);
        const health = values.some((value) => value.state === "paused")
          ? "paused"
          : values.some(
                (value) =>
                  value.state === "degraded" || Number(value.errors) > 0,
              )
            ? "degraded"
            : values.some((value) => value.state === "limited")
              ? "limited"
              : values.length
                ? "healthy"
                : "pending";
        const searches = values.reduce(
          (total, value) => total + Number(value.searches || 0),
          0,
        );
        const errors = values.reduce(
          (total, value) => total + Number(value.errors || 0),
          0,
        );
        return `<span class="connection-source ${health}">
          <i data-lucide="${health === "paused" ? "pause" : health === "degraded" ? "triangle-alert" : health === "limited" ? "clock-3" : "check-circle-2"}"></i>
          <span><strong>${escapeHtml(label)}</strong><small>${searches} intentos · ${errors} fallos</small></span>
        </span>`;
      })
      .join("");
  }

  function priceText(monitor) {
    const joiner = monitor.priceMatch === "both" ? "y" : "o";
    const safety = Number(monitor.priceSafetyPercent ?? 5);
    return `${monitor.maxTotal || 0} € total ${joiner} ${monitor.maxNightly || 0} €/noche · margen ${safety}%`;
  }

  function dateText(monitor) {
    if (monitor.dateMode === "fixed") {
      return `${formatDate(monitor.dateStart)} - ${formatDate(monitor.dateEnd)}`;
    }
    if (monitor.dateMode === "range") {
      return `${monitor.minNights}-${monitor.maxNights} noches entre ${formatDate(
        monitor.dateStart,
      )} y ${formatDate(monitor.dateEnd)}`;
    }
    return `${monitor.minNights}-${monitor.maxNights} noches · ${monitor.windowDays} días`;
  }

  function radiusText(monitor) {
    const radius = Number(monitor.maxDistanceKm) || 0;
    const locationRadius = Number(monitor.locationRadiusKm) || 0;
    if (radius > 0) return `hasta ${radius} km alrededor`;
    if (locationRadius > 0) return `zona exacta · ${locationRadius} km`;
    return "zona habitual";
  }

  function sourceLabel(source) {
    return sources.find(([id]) => id === source)?.[1] || source;
  }

  function automaticSourceText(monitor) {
    const selected = (monitor.sources || ["booking"])
      .filter((source) =>
        sources.some(
          ([id, , automatic, , mode]) =>
            id === source &&
            automatic &&
            (monitor.strictPrices === false || mode === "strict"),
        ),
      )
      .map(sourceLabel);
    return selected.length ? selected.join(" + ") : "Sin buscador";
  }

  function statusForMonitor(monitorId) {
    return state.status.monitors?.[monitorId] || null;
  }

  function sourceHealthLabel(sourceStatus) {
    if (!sourceStatus) return "pending";
    if (sourceStatus.state === "paused") return "paused";
    if (sourceStatus.state === "degraded") return "degraded";
    if (sourceStatus.state === "limited") return "limited";
    return "healthy";
  }

  function monitorCoverageMarkup(monitor) {
    const monitorStatus = statusForMonitor(monitor.id);
    const coverage = monitorStatus?.dateCoverage;
    const sourcesStatus = monitorStatus?.sources || {};
    const sourcePills = (monitor.sources || ["booking"])
      .filter((source) => sources.some(([id]) => id === source))
      .map((source) => {
        const current = sourcesStatus[source];
        const health = sourceHealthLabel(current);
        const detail = health === "paused"
          ? `Pausado hasta ${current?.retryAt ? formatDateTime(current.retryAt) : "el siguiente intento"}`
          : health === "degraded"
            ? `${current?.consecutiveErrors || 1} fallo(s) reciente(s)`
            : health === "limited"
              ? current?.lastSkipReason === "calendar_limit"
                ? "Fecha fuera del calendario fiable de Google"
                : "Esperando una fecha candidata"
              : health === "healthy"
                ? "Operativo"
                : "Pendiente del próximo ciclo";
        return `<span class="source-health ${health}" title="${escapeHtml(detail)}">
          <i data-lucide="${health === "paused" ? "pause" : health === "degraded" ? "triangle-alert" : health === "limited" ? "clock-3" : "check"}"></i>
          ${escapeHtml(sourceLabel(source))}
        </span>`;
      })
      .join("");
    if (!coverage) {
      return `<span class="monitor-scan-meta"><span>Sin barrido pendiente</span><span class="source-health-row">${sourcePills}</span></span>`;
    }
    const total = Math.max(1, Number(coverage.totalSearches) || 1);
    const remaining = Math.max(0, Number(coverage.remainingSearchesInSweep) || 0);
    const checked = coverage.completedSweep ? total : Math.max(0, total - remaining);
    const percent = Math.min(100, Math.round((checked / total) * 100));
    return `<span class="monitor-scan-meta">
      <span class="coverage-line">
        <span>Cobertura del barrido</span>
        <b>${checked}/${total} · ${percent}%</b>
      </span>
      <span class="coverage-track"><span style="width:${percent}%"></span></span>
      <span class="source-health-row">${sourcePills}</span>
    </span>`;
  }

  function renderMonitorList() {
    const monitors = state.config.monitors || [];
    $("#monitor-count").textContent = String(monitors.length);
    $("#active-count").textContent = String(
      monitors.filter((monitor) => monitor.active).length,
    );
    $("#monitor-subtitle").textContent = monitors.length
      ? `${monitors.length} búsquedas configuradas.`
      : "Configura destinos, fechas y presupuesto.";

    $("#monitor-list").innerHTML = monitors.length
      ? monitors
          .map(
            (monitor) => `
              <article class="monitor-row ${
                monitor.id === state.selectedId ? "selected" : ""
              }">
                <button class="monitor-main" type="button" data-select="${escapeHtml(
                  monitor.id,
                )}">
                  <span class="hotel-icon"><i data-lucide="hotel"></i></span>
                  <span class="monitor-copy">
                    <span class="monitor-title-line">
                      <strong>${escapeHtml(monitor.name)}</strong>
                      <em class="mini-status ${monitor.active ? "active" : ""}">
                        ${monitor.active ? "Activa" : "Pausada"}
                      </em>
                    </span>
                    <span class="monitor-location">
                      <i data-lucide="map-pin"></i>
                      ${escapeHtml(monitor.location)}
                    </span>
                    <span class="monitor-rule">
                      ${escapeHtml(priceText(monitor))} · ${escapeHtml(
                        dateText(monitor),
                      )} · ${escapeHtml(radiusText(monitor))} · cada ${escapeHtml(
                        monitor.intervalMinutes,
                      )} min | ${escapeHtml(automaticSourceText(monitor))}
                    </span>
                    ${monitorCoverageMarkup(monitor)}
                  </span>
                </button>
                <span class="row-actions">
                  <button
                    type="button"
                    data-toggle="${escapeHtml(monitor.id)}"
                    title="${monitor.active ? "Pausar" : "Activar"}"
                  >
                    <i data-lucide="${monitor.active ? "pause" : "play"}"></i>
                  </button>
                </span>
              </article>
            `,
          )
          .join("")
      : '<p class="monitor-empty">No hay búsquedas guardadas.</p>';

    $$("[data-select]").forEach((button) => {
      button.addEventListener("click", () => selectMonitor(button.dataset.select));
    });
    $$("[data-toggle]").forEach((button) => {
      button.addEventListener("click", () =>
        toggleMonitor(button.dataset.toggle),
      );
    });
  }

  function renderStats() {
    const summary = state.status.summary || {};
    $("#stat-searches").textContent = String(summary.searches || 0);
    $("#stat-offers").textContent = String(summary.offers || 0);
    $("#stat-matches").textContent = String(summary.matches || 0);
  }

  function dealTableHeader() {
    return `
        <div class="table-header">
          <span>Alojamiento</span>
          <span>Estancia</span>
          <span>Precio</span>
          <span>Calidad</span>
          <span></span>
        </div>
    `;
  }

  function propertyLabel(value) {
    return propertyOptions.find(([id]) => id === value)?.[1] || "Alojamiento";
  }

  function mealPlanLabel(value) {
    return {
      breakfast: "Desayuno incluido",
      half_board: "Media pensión",
      all_inclusive: "Todo incluido",
    }[value] || "";
  }

  function dealDetails(deal) {
    const details = [
      deal.freeCancellation ? "Cancelación gratuita" : "",
      deal.breakfastIncluded ? "Desayuno incluido" : mealPlanLabel(deal.mealPlan),
      deal.limitedAvailability ? "Pocas habitaciones" : "",
      ...(deal.amenities || [])
        .slice(0, 4)
        .map((amenity) =>
          amenityOptions.find(([id]) => id === amenity)?.[1] || "",
        ),
    ].filter(Boolean);
    return Array.from(new Set(details)).join(" · ");
  }

  function dealRow(deal) {
    const distance = Number(deal.distanceKm) || 0;
    const distanceLabel = distance > 0
      ? ` · ${distance.toLocaleString("es-ES")} km del destino`
      : "";
    const provider = deal.provider || sourceLabel(deal.source || "booking");
    const quality = deal.guestRating
      ? `Nota ${Number(deal.guestRating).toLocaleString("es-ES")}/10${
          deal.reviewCount
            ? ` · ${Number(deal.reviewCount).toLocaleString("es-ES")} reseñas`
            : ""
        }`
      : "Sin valoración publicada";
    const details = dealDetails(deal);
    const priceNote = ["agoda", "bluepillow"].includes(deal.source)
      ? "Precio de comparador; confirma el total al abrir"
      : deal.taxesText || "Total final comprobado";
    return `
      <article class="deal-row">
        <span class="deal-hotel">
          <strong>${escapeHtml(deal.hotelName)}</strong>
          <small>${escapeHtml(
            `${deal.address || deal.location}${distanceLabel}`,
          )}</small>
          <small class="deal-provider">${escapeHtml(provider)}</small>
        </span>
        <span class="deal-stay">
          <strong>${escapeHtml(formatDate(deal.checkIn))} → ${escapeHtml(
            formatDate(deal.checkOut),
          )}</strong>
          <small>${escapeHtml(deal.nights)} ${
            Number(deal.nights) === 1 ? "noche" : "noches"
          }${deal.roomName ? ` · ${escapeHtml(deal.roomName)}` : ""}</small>
          <small>Encontrada ${escapeHtml(
            formatDateTime(deal.firstSeenAt),
          )} · revisada ${escapeHtml(formatDateTime(deal.updatedAt))}</small>
        </span>
        <span class="deal-price">
          <strong>${Number(deal.totalPrice).toFixed(2)} €</strong>
          <small>${Number(deal.nightlyPrice).toFixed(2)} €/noche</small>
          <small>${escapeHtml(priceNote)}</small>
        </span>
        <span class="deal-quality">
          <strong>${
            deal.stars
              ? `${escapeHtml(deal.stars)} estrellas`
              : "Sin categoría por estrellas"
          } · ${escapeHtml(propertyLabel(deal.propertyType))}</strong>
          <small>${escapeHtml(quality)}</small>
          ${details ? `<small>${escapeHtml(details)}</small>` : ""}
        </span>
        <a
          class="icon-button"
          href="${escapeHtml(safeUrl(deal.url))}"
          target="_blank"
          rel="noreferrer"
          title="Abrir oferta"
        >
          <i data-lucide="external-link"></i>
        </a>
      </article>
    `;
  }

  function fareSignal(deal) {
    const score = Number(deal.errorFareScore) || 0;
    const level = deal.errorFareLevel || "normal";
    const label = {
      probable_error: "Posible tarifa error",
      unusually_low: "Muy por debajo del mercado",
      good_price: "Buen precio",
      normal: "Precio verificado",
    }[level] || "Precio verificado";
    return { score, level, label };
  }

  function providerPriceNote(deal) {
    if (deal.priceChangedDuringConfirmation) {
      return `Actualizado desde ${Number(deal.firstObservedPrice || 0).toFixed(2)} €`;
    }
    if (["agoda", "bluepillow"].includes(deal.source)) {
      return "Comparador revalidado; confirma al abrir";
    }
    return deal.taxesText || "Total final comprobado";
  }

  function comparisonDeal(group) {
    const ordered = [...group].sort(
      (left, right) => Number(left.totalPrice) - Number(right.totalPrice),
    );
    const primary = ordered[0];
    const signal = fareSignal(primary);
    const distance = Number(primary.distanceKm) || 0;
    const quality = primary.guestRating
      ? `Nota ${Number(primary.guestRating).toLocaleString("es-ES")}/10${
          primary.reviewCount
            ? ` · ${Number(primary.reviewCount).toLocaleString("es-ES")} reseñas`
            : ""
        }`
      : "Sin valoración publicada";
    const details = dealDetails(primary);
    const market = Number(primary.marketSampleSize) >= 5
      ? `${Number(primary.discountPercent || 0).toLocaleString("es-ES")}% bajo la referencia de ${Number(primary.marketMedianNightly).toFixed(2)} €/noche`
      : "Sin referencia suficiente para comparar";
    return `
      <article class="deal-comparison">
        <header class="deal-comparison-heading">
          <span class="deal-comparison-title">
            <span class="fare-signal ${escapeHtml(signal.level)}">
              <i data-lucide="${signal.level === "probable_error" ? "flame" : "badge-check"}"></i>
              ${escapeHtml(signal.label)}${signal.score ? ` · ${signal.score}/99` : ""}
            </span>
            <strong>${escapeHtml(primary.hotelName)}</strong>
            <small>${escapeHtml(primary.address || primary.location)}${
              distance > 0
                ? ` · ${distance.toLocaleString("es-ES")} km del destino`
                : ""
            }</small>
          </span>
          <span class="deal-comparison-price">
            <small>Desde</small>
            <strong>${Number(primary.totalPrice).toFixed(2)} €</strong>
            <small>${Number(primary.nightlyPrice).toFixed(2)} €/noche</small>
          </span>
        </header>
        <div class="deal-comparison-facts">
          <span><i data-lucide="calendar-days"></i>${escapeHtml(formatDate(primary.checkIn))} → ${escapeHtml(formatDate(primary.checkOut))} · ${escapeHtml(primary.nights)} ${Number(primary.nights) === 1 ? "noche" : "noches"}</span>
          <span><i data-lucide="star"></i>${primary.stars ? `${escapeHtml(primary.stars)} estrellas` : "Sin estrellas"} · ${escapeHtml(quality)}</span>
          <span><i data-lucide="chart-no-axes-column-increasing"></i>${escapeHtml(market)}</span>
          ${details ? `<span><i data-lucide="sparkles"></i>${escapeHtml(details)}</span>` : ""}
        </div>
        <div class="provider-offers">
          <div class="provider-offers-heading">
            <span>${ordered.length} ${ordered.length === 1 ? "tarifa comprobada" : "tarifas comparadas"}</span>
            <small>Revisado ${escapeHtml(formatDateTime(primary.updatedAt))}</small>
          </div>
          ${ordered
            .map(
              (deal, index) => `
                <div class="provider-offer">
                  <span class="provider-offer-name">
                    <strong>${escapeHtml(deal.provider || sourceLabel(deal.source || "booking"))}</strong>
                    <small>${escapeHtml(providerPriceNote(deal))}</small>
                  </span>
                  ${index === 0 && ordered.length > 1 ? '<span class="best-price">Mejor</span>' : ""}
                  <span class="provider-offer-price">
                    <strong>${Number(deal.totalPrice).toFixed(2)} €</strong>
                    <small>${Number(deal.nightlyPrice).toFixed(2)} €/noche</small>
                  </span>
                  <a class="icon-button" href="${escapeHtml(safeUrl(deal.url))}" target="_blank" rel="noreferrer" title="Abrir en ${escapeHtml(sourceLabel(deal.source || "booking"))}">
                    <i data-lucide="external-link"></i>
                  </a>
                </div>
              `,
            )
            .join("")}
        </div>
      </article>
    `;
  }

  function emptyDeals(message) {
    return `
        <div class="empty-state">
          <span><i data-lucide="radar"></i></span>
          <strong>Sin ofertas en esta búsqueda</strong>
          <p>${escapeHtml(message)}</p>
        </div>
    `;
  }

  function renderDeals() {
    const deals = (state.deals.deals || []).filter(
      (deal) => deal.priceVerified === true,
    );
    const monitorById = new Map(
      state.config.monitors.map((monitor) => [String(monitor.id), monitor]),
    );
    const filter = $("#deal-monitor-filter");
    const knownMonitorIds = new Set(state.config.monitors.map((monitor) =>
      String(monitor.id),
    ));
    if (
      state.dealMonitorFilter !== "all" &&
      !knownMonitorIds.has(state.dealMonitorFilter)
    ) {
      state.dealMonitorFilter = "all";
    }

    filter.innerHTML = [
      `<option value="all">Todas las búsquedas (${deals.length})</option>`,
      ...state.config.monitors.map((monitor) => {
        const count = deals.filter(
          (deal) => String(deal.monitorId) === String(monitor.id),
        ).length;
        return `<option value="${escapeHtml(monitor.id)}">${escapeHtml(monitor.name)} (${count})</option>`;
      }),
    ].join("");
    filter.value = state.dealMonitorFilter;

    const filteredDeals = state.dealMonitorFilter === "all"
      ? deals
      : deals.filter(
        (deal) => String(deal.monitorId) === state.dealMonitorFilter,
      );
    $("#deal-count").textContent = String(deals.length);

    if (!filteredDeals.length) {
      const selectedMonitor = monitorById.get(state.dealMonitorFilter);
      $("#deals-table").innerHTML = emptyDeals(
        selectedMonitor
          ? `Todavía no hay coincidencias para ${selectedMonitor.name}.`
          : "Las ofertas aparecerán aquí después del siguiente ciclo.",
      );
      return;
    }

    const groupedDeals = new Map();
    for (const deal of filteredDeals) {
      const groupId = String(deal.monitorId || "unknown");
      if (!groupedDeals.has(groupId)) groupedDeals.set(groupId, []);
      groupedDeals.get(groupId).push(deal);
    }

    $("#deals-table").innerHTML = Array.from(groupedDeals.entries())
      .map(([monitorId, group]) => {
        const monitor = monitorById.get(monitorId);
        const name = monitor?.name || group[0].monitorName || group[0].location;
        const location = monitor?.location || group[0].location || "";
        const comparisonGroups = new Map();
        for (const deal of group) {
          const comparisonId = deal.comparisonGroupId || deal.id;
          if (!comparisonGroups.has(comparisonId)) {
            comparisonGroups.set(comparisonId, []);
          }
          comparisonGroups.get(comparisonId).push(deal);
        }
        return `
          <section class="deal-group">
            <header class="deal-group-header">
              <span>
                <strong>${escapeHtml(name)}</strong>
                <small>${escapeHtml(location)}</small>
              </span>
              <b>${comparisonGroups.size} ${comparisonGroups.size === 1 ? "alojamiento" : "alojamientos"} · ${group.length} ${group.length === 1 ? "tarifa" : "tarifas"}</b>
            </header>
            ${Array.from(comparisonGroups.values())
              .sort(
                (left, right) =>
                  Math.min(...left.map((deal) => Number(deal.totalPrice))) -
                  Math.min(...right.map((deal) => Number(deal.totalPrice))),
              )
              .map(comparisonDeal)
              .join("")}
          </section>
        `;
      })
      .join("");
  }

  function renderOptionButtons(containerSelector, options, selected, key) {
    const container = $(containerSelector);
    container.innerHTML = options
      .map(
        ([id, label]) => `
          <button
            type="button"
            class="${selected.includes(id) ? "selected" : ""}"
            data-option-key="${key}"
            data-option-id="${id}"
          >
            <span>${escapeHtml(label)}</span>
            <i data-lucide="${selected.includes(id) ? "check" : "plus"}"></i>
          </button>
        `,
      )
      .join("");
    container.querySelectorAll("[data-option-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const values = state.draft[key];
        state.draft[key] = values.includes(button.dataset.optionId)
          ? values.filter((value) => value !== button.dataset.optionId)
          : [...values, button.dataset.optionId];
        renderEditorOptions();
        renderRulePreview();
      });
    });
  }

  function renderEditorOptions() {
    $("#star-picker").innerHTML = [0, 1, 2, 3, 4, 5]
      .map(
        (stars) => `
          <button
            type="button"
            class="${state.draft.minStars === stars ? "selected" : ""}"
            data-stars="${stars}"
          >
            ${stars === 0 ? "Todas" : `${stars} <i data-lucide="star"></i>`}
          </button>
        `,
      )
      .join("");
    $$("[data-stars]").forEach((button) => {
      button.addEventListener("click", () => {
        state.draft.minStars = Number(button.dataset.stars);
        renderEditorOptions();
        renderRulePreview();
      });
    });
    renderOptionButtons(
      "#property-types",
      propertyOptions,
      state.draft.propertyTypes,
      "propertyTypes",
    );
    renderOptionButtons(
      "#amenities",
      amenityOptions,
      state.draft.amenities,
      "amenities",
    );
    const selectedSources = Array.isArray(state.draft.sources)
      ? state.draft.sources
      : ["booking"];
    $("#source-grid").innerHTML = sources
      .map(
        ([id, label, automatic, detail, sourceMode]) =>
          automatic
            ? `
              <button
                type="button"
                class="${
                  selectedSources.includes(id) &&
                  (state.draft.strictPrices === false || sourceMode === "strict")
                    ? "selected"
                    : ""
                }"
                data-source-id="${id}"
                aria-pressed="${
                  selectedSources.includes(id) &&
                  (state.draft.strictPrices === false || sourceMode === "strict")
                }"
                ${
                  state.draft.strictPrices !== false && sourceMode === "comparison"
                    ? "disabled"
                    : ""
                }
              >
                <span>${escapeHtml(label)}<small>${escapeHtml(
                  state.draft.strictPrices !== false && sourceMode === "comparison"
                    ? "Desactivado en máxima precisión"
                    : detail || "Automático",
                )}</small></span>
                <i data-lucide="${
                  selectedSources.includes(id) &&
                  (state.draft.strictPrices === false || sourceMode === "strict")
                    ? "check"
                    : "plus"
                }"></i>
              </button>
            `
            : `
              <span>
                <span>${escapeHtml(label)}<small>Enlace manual</small></span>
                <i data-lucide="external-link"></i>
              </span>
            `,
      )
      .join("");
    $$("[data-source-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const source = button.dataset.sourceId;
        const values = Array.isArray(state.draft.sources)
          ? state.draft.sources
          : ["booking"];
        state.draft.sources = values.includes(source)
          ? values.filter((value) => value !== source)
          : [...values, source];
        renderEditorOptions();
        renderRulePreview();
      });
    });
    refreshIcons();
  }

  function setDateMode(mode) {
    state.draft.dateMode = mode;
    $$("[data-date-mode]").forEach((button) => {
      button.classList.toggle("selected", button.dataset.dateMode === mode);
    });
    $("#flexible-fields").classList.toggle("hidden", mode === "fixed");
    $("#window-field").classList.toggle("hidden", mode !== "flexible");
    $("#fixed-fields").classList.toggle(
      "hidden",
      mode !== "fixed" && mode !== "range",
    );
    $("#date-start-label").textContent = mode === "range" ? "Desde" : "Entrada";
    $("#date-end-label").textContent = mode === "range" ? "Hasta" : "Salida";
    renderRulePreview();
  }

  function fillEditor() {
    const draft = state.draft;
    const hasLocationCoordinates =
      Number.isFinite(Number(draft.latitude)) &&
      Number.isFinite(Number(draft.longitude));
    state.locationContext =
      draft.locationId &&
      hasLocationCoordinates &&
      String(draft.locationType || "").toLowerCase() !== "country"
        ? {
            latitude: Number(draft.latitude),
            longitude: Number(draft.longitude),
            countryCode: draft.countryCode || "",
            locationCity:
              draft.locationCity || String(draft.location || "").split(",")[0],
          }
        : null;
    draft.sources = Array.isArray(draft.sources) && draft.sources.length
      ? draft.sources
      : ["booking"];
    const nearbyLocations =
      state.status.monitors?.[draft.id]?.nearbyLocations || [];
    $("#editor-title").textContent = state.config.monitors.some(
      (monitor) => monitor.id === draft.id,
    )
      ? "Editar búsqueda"
      : "Nueva búsqueda";
    $("#editor-status").textContent = draft.active ? "Activa" : "Pausada";
    $("#editor-status").classList.toggle("ready", draft.active);
    $("#monitor-name").value = draft.name;
    $("#location-query").value = draft.location;
    const detectedType = locationTypeLabel(draft.locationType);
    $("#location-confirmed").innerHTML = draft.locationId
      ? `<i data-lucide="map-pin-check"></i> Destino verificado · ${escapeHtml(detectedType)} · ${escapeHtml(
          draft.countryCode || "",
        )}${Number(draft.locationRadiusKm) > 0
          ? ` · radio ${escapeHtml(draft.locationRadiusKm)} km`
          : ""}${nearbyLocations.length
          ? ` · También: ${escapeHtml(nearbyLocations.join(", "))}`
          : ""}`
      : "";
    $("#min-nights").value = draft.minNights;
    $("#max-nights").value = draft.maxNights;
    $("#window-days").value = String(draft.windowDays);
    $("#date-start").value = draft.dateStart || "";
    $("#date-end").value = draft.dateEnd || "";
    $("#max-total").value = draft.maxTotal;
    $("#max-nightly").value = draft.maxNightly;
    $("#price-match").value = draft.priceMatch;
    $("#price-safety").value = String(draft.priceSafetyPercent ?? 5);
    $("#guest-rating").value = String(draft.guestRatingMin);
    $("#max-distance").value = String(draft.maxDistanceKm);
    $("#free-cancellation").checked = draft.freeCancellation;
    $("#meal-plan").value = draft.mealPlan;
    $("#adults").value = draft.adults;
    $("#children").value = draft.children;
    $("#rooms").value = draft.rooms;
    $("#interval-minutes").value = String(draft.intervalMinutes);
    $("#strict-prices").checked = draft.strictPrices !== false;
    $("#monitor-active").checked = draft.active;
    $("#delete-button").disabled = !state.config.monitors.some(
      (monitor) => monitor.id === draft.id,
    );
    $("#form-error").textContent = "";
    setDateMode(draft.dateMode);
    renderEditorOptions();
    renderRulePreview();
    renderManualLinks();
    refreshIcons();
  }

  function syncDraftFromInputs() {
    const draft = state.draft;
    draft.name = $("#monitor-name").value.trim();
    draft.location = $("#location-query").value.trim();
    draft.minNights = Number($("#min-nights").value) || 1;
    draft.maxNights = Number($("#max-nights").value) || draft.minNights;
    draft.windowDays = Number($("#window-days").value) || 180;
    draft.dateStart = $("#date-start").value || null;
    draft.dateEnd = $("#date-end").value || null;
    draft.maxTotal = Number($("#max-total").value) || 0;
    draft.maxNightly = Number($("#max-nightly").value) || 0;
    draft.priceMatch = $("#price-match").value;
    draft.priceSafetyPercent = Number($("#price-safety").value) || 0;
    draft.guestRatingMin = Number($("#guest-rating").value) || 0;
    draft.maxDistanceKm = Number($("#max-distance").value) || 0;
    draft.freeCancellation = $("#free-cancellation").checked;
    draft.mealPlan = $("#meal-plan").value;
    draft.adults = Number($("#adults").value) || 1;
    draft.children = Number($("#children").value) || 0;
    draft.rooms = Number($("#rooms").value) || 1;
    draft.intervalMinutes = Math.max(
      5,
      Number($("#interval-minutes").value) || 5,
    );
    draft.strictPrices = $("#strict-prices").checked;
    draft.active = $("#monitor-active").checked;
    draft.sources = Array.isArray(draft.sources) ? draft.sources : ["booking"];
  }

  function renderRulePreview() {
    syncDraftFromInputs();
    const draft = state.draft;
    const stars = draft.minStars ? `${draft.minStars}+ estrellas` : "con o sin estrellas";
    const dates =
      draft.dateMode === "fixed"
        ? `${draft.dateStart || "entrada"} a ${draft.dateEnd || "salida"}`
        : draft.dateMode === "range"
          ? `${draft.minNights}-${draft.maxNights} noches entre ${
              draft.dateStart || "inicio"
            } y ${draft.dateEnd || "fin"}`
        : `${draft.minNights}-${draft.maxNights} noches`;
    const activeSources = automaticSourceText(draft);
    $("#rule-preview").innerHTML = `
      <span><i data-lucide="radar"></i></span>
      <div>
        <strong>${escapeHtml(draft.location || "Destino")} · ${escapeHtml(dates)}</strong>
        <p>${escapeHtml(priceText(draft))} · ${escapeHtml(stars)} · ${escapeHtml(
          radiusText(draft),
        )} · ${escapeHtml(activeSources)} automático</p>
      </div>
    `;
    refreshIcons();
  }

  function buildSearchLinks(monitor) {
    const encoded = encodeURIComponent(monitor.location);
    const exact =
      monitor.dateMode === "fixed" && monitor.dateStart && monitor.dateEnd;
    const bookingDates = exact
      ? `&checkin=${monitor.dateStart}&checkout=${monitor.dateEnd}`
      : "";
    const bookingGuests =
      `&group_adults=${monitor.adults}` +
      `&group_children=${monitor.children}` +
      `&no_rooms=${monitor.rooms}` +
      "&selected_currency=EUR";
    const query = encodeURIComponent(
      `${monitor.location} hotel ${monitor.minNights} noches`,
    );
    return [
      [
        "Booking",
        `https://www.booking.com/searchresults.es.html?ss=${encoded}${bookingDates}${bookingGuests}`,
      ],
      ["Google Hoteles", `https://www.google.com/travel/search?q=${query}`],
      ["Agoda", `https://www.agoda.com/es-es/search?textToSearch=${encoded}`],
      ["Trip.com", `https://es.trip.com/hotels/list?city=${encoded}`],
      ["Bluepillow", "https://www.bluepillow.es/"],
    ];
  }

  function renderManualLinks() {
    $("#manual-links").innerHTML = buildSearchLinks(state.draft)
      .map(
        ([label, url]) => `
          <a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noreferrer">
            <span>${escapeHtml(label)}</span>
            <i data-lucide="external-link"></i>
          </a>
        `,
      )
      .join("");
    refreshIcons();
  }

  function selectMonitor(id) {
    const monitor = state.config.monitors.find((item) => item.id === id);
    if (!monitor) return;
    state.selectedId = id;
    state.draft = clone(monitor);
    renderMonitorList();
    fillEditor();
    if (window.innerWidth < 781) closeSidebar();
  }

  function newMonitor() {
    state.selectedId = null;
    state.draft = defaultMonitor();
    renderMonitorList();
    fillEditor();
    switchView("monitors");
    $("#monitor-name").focus();
  }

  async function toggleMonitor(id) {
    const monitor = state.config.monitors.find((item) => item.id === id);
    if (!monitor) return;
    monitor.active = !monitor.active;
    monitor.updatedAt = new Date().toISOString();
    setBusy(true);
    try {
      state.config.updatedAt = new Date().toISOString();
      await saveConfig(state.config);
      if (state.selectedId === id) {
        state.draft = clone(monitor);
        fillEditor();
      }
      renderMonitorList();
      showToast(monitor.active ? "Búsqueda activada." : "Búsqueda pausada.");
    } catch (error) {
      monitor.active = !monitor.active;
      showToast(`No se pudo guardar: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function validateDraft(draft) {
    if (!draft.name) return "Escribe un nombre para la búsqueda.";
    if (!draft.locationId || !draft.location) {
      return "Selecciona una ubicación de la lista de resultados.";
    }
    if (!draft.maxTotal && !draft.maxNightly) {
      return "Indica al menos un límite de precio.";
    }
    if (
      !(draft.sources || []).some((source) =>
        sources.some(
          ([id, , automatic, , mode]) =>
            id === source &&
            automatic &&
            (draft.strictPrices === false || mode === "strict"),
        ),
      )
    ) {
      return "Activa al menos un buscador automatico.";
    }
    if (draft.dateMode === "fixed") {
      if (!draft.dateStart || !draft.dateEnd) {
        return "Selecciona las fechas de entrada y salida.";
      }
      const nights = nightsBetween(draft.dateStart, draft.dateEnd);
      if (nights < 1) return "La salida debe ser posterior a la entrada.";
      draft.minNights = nights;
      draft.maxNights = nights;
    } else {
      if (draft.maxNights < draft.minNights) {
        return "Las noches máximas no pueden ser menores que las mínimas.";
      }
      if (draft.dateMode === "range") {
        if (!draft.dateStart || !draft.dateEnd) {
          return "Selecciona el inicio y el final del rango.";
        }
        const availableNights = nightsBetween(draft.dateStart, draft.dateEnd);
        if (availableNights < 1) {
          return "El final del rango debe ser posterior al inicio.";
        }
        if (draft.minNights > availableNights) {
          return "El rango es más corto que la estancia mínima.";
        }
      }
    }
    return "";
  }

  async function handleSave(event) {
    event.preventDefault();
    syncDraftFromInputs();
    const error = validateDraft(state.draft);
    $("#form-error").textContent = error;
    if (error) return;

    const now = new Date().toISOString();
    state.draft.updatedAt = now;
    const existingIndex = state.config.monitors.findIndex(
      (monitor) => monitor.id === state.draft.id,
    );
    if (existingIndex >= 0) {
      state.config.monitors[existingIndex] = clone(state.draft);
    } else {
      state.draft.createdAt = now;
      state.config.monitors.push(clone(state.draft));
    }
    state.config.updatedAt = now;
    state.selectedId = state.draft.id;

    setBusy(true);
    try {
      await saveConfig(state.config);
      renderAll();
      fillEditor();
      showToast("Búsqueda guardada. El panel se actualizará al terminar el ciclo.");
    } catch (saveError) {
      $("#form-error").textContent = `No se pudo guardar: ${saveError.message}`;
      await loadAll().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    const exists = state.config.monitors.some(
      (monitor) => monitor.id === state.draft.id,
    );
    if (!exists) return;
    const confirmed = window.confirm(
      `¿Eliminar la búsqueda "${state.draft.name}"?`,
    );
    if (!confirmed) return;
    state.config.monitors = state.config.monitors.filter(
      (monitor) => monitor.id !== state.draft.id,
    );
    state.config.updatedAt = new Date().toISOString();
    setBusy(true);
    try {
      await saveConfig(state.config);
      const next = state.config.monitors[0];
      if (next) selectMonitor(next.id);
      else newMonitor();
      showToast("Búsqueda eliminada.");
    } catch (error) {
      showToast(`No se pudo eliminar: ${error.message}`);
      await loadAll().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  function locationContextFingerprint() {
    if (!state.locationContext) return "global";
    return [
      Number(state.locationContext.latitude).toFixed(2),
      Number(state.locationContext.longitude).toFixed(2),
      state.locationContext.countryCode || "",
    ].join(":");
  }

  function suggestionCacheKey(query) {
    return `${String(query || "").trim().toLocaleLowerCase("es")}|${locationContextFingerprint()}`;
  }

  function readLocationSuggestionCache(query) {
    try {
      const entries = JSON.parse(
        localStorage.getItem(LOCATION_SUGGESTION_CACHE_STORAGE) || "[]",
      );
      const key = suggestionCacheKey(query);
      const entry = entries.find((item) => item.key === key);
      const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
      return entry && Date.now() - Number(entry.savedAt) < maxAgeMs
        ? entry.locations
        : null;
    } catch {
      return null;
    }
  }

  function writeLocationSuggestionCache(query, locations) {
    try {
      const key = suggestionCacheKey(query);
      const current = JSON.parse(
        localStorage.getItem(LOCATION_SUGGESTION_CACHE_STORAGE) || "[]",
      ).filter((item) => item.key !== key);
      current.unshift({ key, savedAt: Date.now(), locations });
      localStorage.setItem(
        LOCATION_SUGGESTION_CACHE_STORAGE,
        JSON.stringify(current.slice(0, 50)),
      );
    } catch {
      // Suggestions still work when browser storage is unavailable.
    }
  }

  async function fetchPhotonLocations(query, signal, context) {
    const cached = readLocationSuggestionCache(query);
    if (cached) return cached;
    const url = new URL(SUGGESTION_GEOCODER_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "10");
    url.searchParams.set("lang", "en");
    if (context) {
      url.searchParams.set("lat", String(context.latitude));
      url.searchParams.set("lon", String(context.longitude));
      url.searchParams.set("zoom", "12");
      url.searchParams.set("location_bias_scale", "0.7");
    }
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) throw new Error("No se pudieron cargar las sugerencias.");
    const payload = await response.json();
    const locations = (payload.features || [])
      .map((feature) => normalizePhotonLocation(feature, context))
      .filter((location) => location.label);
    writeLocationSuggestionCache(query, locations);
    return locations;
  }

  async function fetchCityLocations(query, signal) {
    const response = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        query,
      )}&count=8&language=es&format=json`,
      { signal },
    );
    if (!response.ok) throw new Error("No se pudo consultar el destino.");
    const payload = await response.json();
    return (payload.results || [])
      .map(normalizeOpenMeteoLocation)
      .filter((location) => location.label);
  }

  async function searchLocationSuggestions(query, requestId) {
    state.locationAbortController?.abort();
    const controller = new AbortController();
    state.locationAbortController = controller;
    const context = state.locationContext
      ? { ...state.locationContext }
      : null;
    const requests = [fetchCityLocations(query, controller.signal)];
    if (query.length >= 3) {
      requests.unshift(fetchPhotonLocations(query, controller.signal, context));
    }
    const results = await Promise.allSettled(requests);
    if (requestId !== state.locationRequest) return;
    const fulfilled = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    if (!fulfilled.length) {
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.reason?.name === "AbortError") return;
      throw failure?.reason || new Error("No se pudo consultar el destino.");
    }
    state.locationResults = mergeLocationResults(...fulfilled).slice(0, 12);
    renderLocationResults();
  }

  function locationCacheKey(query) {
    return `${String(query || "").trim().toLocaleLowerCase("es")}|${locationContextFingerprint()}`;
  }

  function readDetailedLocationCache(query) {
    try {
      const entries = JSON.parse(
        localStorage.getItem(LOCATION_CACHE_STORAGE) || "[]",
      );
      const key = locationCacheKey(query);
      const entry = entries.find((item) => item.key === key);
      const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
      return entry && Date.now() - Number(entry.savedAt) < maxAgeMs
        ? entry.locations
        : null;
    } catch {
      return null;
    }
  }

  function writeDetailedLocationCache(query, locations) {
    try {
      const key = locationCacheKey(query);
      const current = JSON.parse(
        localStorage.getItem(LOCATION_CACHE_STORAGE) || "[]",
      ).filter((item) => item.key !== key);
      current.unshift({ key, savedAt: Date.now(), locations });
      localStorage.setItem(
        LOCATION_CACHE_STORAGE,
        JSON.stringify(current.slice(0, 25)),
      );
    } catch {
      // The search still works when browser storage is unavailable.
    }
  }

  function setDetailedLocationBusy(busy) {
    state.locationSearchBusy = busy;
    const button = $("#location-search-button");
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
  }

  function renderLocationMessage(message) {
    const container = $("#location-results");
    container.innerHTML = `<span class="location-result-message">${escapeHtml(
      message,
    )}</span>`;
    container.classList.remove("hidden");
  }

  async function searchDetailedLocations() {
    const query = $("#location-query").value.trim();
    if (query.length < 2 || state.locationSearchBusy) return;
    clearTimeout(state.locationTimer);
    state.locationAbortController?.abort();
    const requestId = ++state.locationRequest;
    setDetailedLocationBusy(true);
    $("#form-error").textContent = "";
    renderLocationMessage("Buscando barrios, calles y zonas…");

    try {
      const context = state.locationContext
        ? { ...state.locationContext }
        : null;
      let locations = readDetailedLocationCache(query);
      if (!locations) {
        const elapsed = Date.now() - state.lastDetailedLocationRequestAt;
        if (elapsed < 1_000) {
          await new Promise((resolve) => setTimeout(resolve, 1_000 - elapsed));
        }
        const url = new URL(DETAILED_GEOCODER_URL);
        url.searchParams.set("q", query);
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("addressdetails", "1");
        url.searchParams.set("limit", "8");
        url.searchParams.set("dedupe", "1");
        url.searchParams.set("namedetails", "1");
        url.searchParams.set(
          "layer",
          "address,poi,railway,natural,manmade",
        );
        url.searchParams.set("accept-language", "es,en,zh");
        if (context) {
          const latitude = Number(context.latitude);
          const longitude = Number(context.longitude);
          url.searchParams.set(
            "viewbox",
            [
              longitude - 0.8,
              latitude + 0.6,
              longitude + 0.8,
              latitude - 0.6,
            ].join(","),
          );
          url.searchParams.set("bounded", "0");
        }
        state.lastDetailedLocationRequestAt = Date.now();
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          throw new Error("No se pudo consultar la ubicación detallada.");
        }
        const payload = await response.json();
        locations = payload.map(normalizeNominatimLocation);
        writeDetailedLocationCache(query, locations);
      }

      if (requestId !== state.locationRequest) return;
      state.locationResults = mergeLocationResults(
        locations,
        state.locationResults,
      ).slice(0, 10);
      if (state.locationResults.length) {
        renderLocationResults();
      } else {
        renderLocationMessage("No se encontró esa ubicación.");
      }
    } catch (error) {
      if (requestId === state.locationRequest) {
        renderLocationMessage("No se pudo completar la búsqueda.");
        $("#form-error").textContent = error.message;
      }
    } finally {
      setDetailedLocationBusy(false);
    }
  }

  function selectLocation(location) {
    state.draft.location = location.label;
    state.draft.locationId = location.id;
    state.draft.latitude = location.latitude;
    state.draft.longitude = location.longitude;
    state.draft.countryCode = location.countryCode;
    state.draft.locationType = location.locationType || "place";
    state.draft.locationCity = location.locationCity || "";
    state.draft.locationRadiusKm = Number(location.locationRadiusKm) || 0;
    state.locationContext = {
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      countryCode: location.countryCode || "",
      locationCity: location.locationCity || location.name || "",
    };
    $("#location-query").value = location.label;
    const type = locationTypeLabel(location.locationType);
    $("#location-confirmed").innerHTML =
      `<i data-lucide="map-pin-check"></i> Destino verificado · ${escapeHtml(type)} · ` +
      `${escapeHtml(location.countryCode)}${state.draft.locationRadiusKm
        ? ` · radio ${escapeHtml(state.draft.locationRadiusKm)} km`
        : ""}`;
    $("#location-results").classList.add("hidden");
    renderRulePreview();
    renderManualLinks();
    refreshIcons();
  }

  function renderLocationResults() {
    const container = $("#location-results");
    container.innerHTML = state.locationResults
      .map(
        (location, index) => `
          <button
            class="location-option"
            type="button"
            role="option"
            aria-selected="false"
            data-location-index="${index}"
          >
            <span><i data-lucide="map-pin"></i></span>
            <span>
              <strong>${escapeHtml(location.label)}</strong>
              <small>${escapeHtml(location.details || "Ubicación verificada")}</small>
            </span>
            <b>${escapeHtml(location.countryCode)}</b>
          </button>
        `,
      )
      .join("");
    container.classList.toggle("hidden", !state.locationResults.length);
    container.querySelectorAll("[data-location-index]").forEach((button) => {
      button.addEventListener("click", () => {
        const location = state.locationResults[Number(button.dataset.locationIndex)];
        selectLocation(location);
      });
    });
    refreshIcons();
  }

  function handleLocationInput(event) {
    const value = event.target.value.trim();
    state.draft.location = value;
    state.draft.locationId = "";
    state.draft.latitude = null;
    state.draft.longitude = null;
    state.draft.locationType = "";
    state.draft.locationCity = "";
    state.draft.locationRadiusKm = 0;
    $("#location-confirmed").textContent = "";
    clearTimeout(state.locationTimer);
    state.locationAbortController?.abort();
    const requestId = ++state.locationRequest;
    if (value.length < 2) {
      state.locationResults = [];
      renderLocationResults();
      return;
    }
    state.locationTimer = setTimeout(() => {
      searchLocationSuggestions(value, requestId).catch((error) => {
        if (error?.name === "AbortError") return;
        $("#form-error").textContent = error.message;
      });
    }, 650);
  }

  function switchView(view) {
    state.view = view;
    $$(".view").forEach((section) =>
      section.classList.toggle("active", section.id === `${view}-view`),
    );
    $$(".nav-button").forEach((button) =>
      button.classList.toggle("active", button.dataset.view === view),
    );
    const titles = {
      monitors: "Búsquedas guardadas",
      deals: "Ofertas encontradas",
      connections: "Conexiones",
    };
    $("#view-title").textContent = titles[view];
    $("#new-monitor-button").classList.toggle("hidden", view !== "monitors");
    closeSidebar();
  }

  function openSidebar() {
    $("#sidebar").classList.add("sidebar-open");
    $("#sidebar-scrim").classList.remove("hidden");
  }

  function closeSidebar() {
    $("#sidebar").classList.remove("sidebar-open");
    $("#sidebar-scrim").classList.add("hidden");
  }

  function renderAll() {
    renderMonitorList();
    renderStats();
    renderDeals();
    renderConnectionState();
    refreshIcons();
  }

  async function loadAll() {
    setBusy(true);
    try {
      const [config, status, deals] = await Promise.all([
        getFile(CONFIG_PATH, { version: 1, monitors: [] }),
        getFile(STATUS_PATH, { summary: {}, monitors: {}, alerts: [] }),
        getFile(DEALS_PATH, { deals: [] }),
      ]);
      state.config = config.value;
      state.status = status.value;
      state.deals = deals.value;
      const selected = state.config.monitors.find(
        (monitor) => monitor.id === state.selectedId,
      );
      const first = selected || state.config.monitors[0];
      state.selectedId = first?.id || null;
      state.draft = clone(first || defaultMonitor());
      renderAll();
      fillEditor();
    } finally {
      setBusy(false);
    }
  }

  async function refreshResults() {
    if (!state.token || resultsRefreshPending) return;
    resultsRefreshPending = true;
    try {
      const [status, deals] = await Promise.all([
        getFile(STATUS_PATH, { summary: {}, monitors: {}, alerts: [] }),
        getFile(DEALS_PATH, { deals: [] }),
      ]);
      state.status = status.value;
      state.deals = deals.value;
      renderStats();
      renderDeals();
      renderConnectionState();
      refreshIcons();
    } finally {
      resultsRefreshPending = false;
    }
  }

  function startAutoRefresh() {
    if (autoRefreshTimer) return;
    autoRefreshTimer = window.setInterval(() => {
      if (!document.hidden && state.token) {
        refreshResults().catch(() => {});
      }
    }, 30_000);
  }

  function showApp() {
    $("#login-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
    startAutoRefresh();
    refreshIcons();
  }

  function showLogin() {
    $("#app-view").classList.add("hidden");
    $("#login-view").classList.remove("hidden");
    $("#access-key").value = "";
    $("#access-key").focus();
    refreshIcons();
  }

  async function login(event) {
    event.preventDefault();
    const accessKey = $("#access-key").value.trim();
    $("#login-error").textContent = "";
    if (!accessKey) return;
    setBusy(true);
    try {
      state.token = await decryptPanelToken(accessKey);
      const repo = await apiFetch(`/repos/${OWNER}/${REPO}`);
      if (!repo.permissions?.push) {
        throw new Error("La clave no tiene permiso para guardar búsquedas.");
      }
      state.accessKey = accessKey;
      localStorage.setItem(ACCESS_KEY_STORAGE, accessKey);
      await loadAll();
      showApp();
    } catch (error) {
      state.accessKey = "";
      state.token = "";
      localStorage.removeItem(ACCESS_KEY_STORAGE);
      $("#login-error").textContent =
        error.status === 401 || error.status === 404
          ? "La clave no es válida."
          : "La clave no es válida.";
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    state.accessKey = "";
    state.token = "";
    localStorage.removeItem(ACCESS_KEY_STORAGE);
    showLogin();
  }

  function bindEvents() {
    $("#login-form").addEventListener("submit", login);
    $("#logout-button").addEventListener("click", logout);
    $("#refresh-button").addEventListener("click", () => {
      loadAll()
        .then(() => showToast("Datos actualizados."))
        .catch((error) => showToast(`No se pudo actualizar: ${error.message}`));
    });
    $("#new-monitor-button").addEventListener("click", newMonitor);
    $("#compact-new-button").addEventListener("click", newMonitor);
    $("#monitor-form").addEventListener("submit", handleSave);
    $("#delete-button").addEventListener("click", deleteSelected);
    $("#deal-monitor-filter").addEventListener("change", (event) => {
      state.dealMonitorFilter = event.target.value;
      renderDeals();
      refreshIcons();
    });
    $("#location-query").addEventListener("input", handleLocationInput);
    $("#location-query").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        searchDetailedLocations();
      }
    });
    $("#location-search-button").addEventListener(
      "click",
      searchDetailedLocations,
    );
    $("#location-query").addEventListener("blur", (event) => {
      if (
        event.relatedTarget &&
        event.currentTarget.closest(".location-search").contains(event.relatedTarget)
      ) {
        return;
      }
      setTimeout(() => $("#location-results").classList.add("hidden"), 180);
    });
    $$("[data-date-mode]").forEach((button) => {
      button.addEventListener("click", () => setDateMode(button.dataset.dateMode));
    });
    $("#strict-prices").addEventListener("change", () => {
      state.draft.strictPrices = $("#strict-prices").checked;
      renderEditorOptions();
      renderRulePreview();
    });
    $$("#monitor-form input, #monitor-form select").forEach((input) => {
      if (input.id !== "location-query") {
        input.addEventListener("input", () => {
          renderRulePreview();
          renderManualLinks();
        });
      }
    });
    $$(".nav-button").forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.view));
    });
    $("#menu-button").addEventListener("click", openSidebar);
    $("#sidebar-scrim").addEventListener("click", closeSidebar);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        $("#location-results").classList.add("hidden");
        closeSidebar();
      }
    });
  }

  async function boot() {
    bindEvents();
    state.draft = defaultMonitor();
    fillEditor();
    refreshIcons();
    if (!state.accessKey) {
      showLogin();
      return;
    }
    try {
      state.token = await decryptPanelToken(state.accessKey);
      await loadAll();
      showApp();
    } catch {
      logout();
      $("#login-error").textContent = "La clave guardada ya no es válida.";
    }
  }

  window.addEventListener("DOMContentLoaded", boot);
})();
