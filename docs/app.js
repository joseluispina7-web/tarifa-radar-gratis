(() => {
  "use strict";

  const OWNER = "joseluispina7-web";
  const REPO = "tarifa-radar-gratis";
  const BRANCH = "main";
  const CONFIG_PATH = "config/searches.json";
  const STATUS_PATH = "docs/data/status.json";
  const DEALS_PATH = "docs/data/deals.json";
  const ACCESS_KEY_STORAGE = "tarifa-radar-panel-key";
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
    ["booking", "Booking", true],
    ["google_hotels", "Google Hoteles", false],
    ["trivago", "Trivago", false],
    ["kayak", "KAYAK", false],
    ["expedia", "Expedia", false],
    ["hotels", "Hotels.com", false],
    ["agoda", "Agoda", false],
    ["trip", "Trip.com", false],
    ["skyscanner", "Skyscanner", false],
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
  };

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
      dateMode: "flexible",
      dateStart: isoDate(start),
      dateEnd: isoDate(addDays(start, 4)),
      windowDays: 180,
      minNights: 4,
      maxNights: 7,
      maxTotal: 150,
      maxNightly: 30,
      priceMatch: "any",
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
    $("#scanner-dot").classList.toggle("online", online);
    $("#scanner-label").textContent = online ? "Escáner activo" : "Esperando ciclo";
    $("#scanner-time").textContent = updatedAt
      ? formatDateTime(updatedAt)
      : "GitHub Actions";
    $("#sync-badge").classList.add("ready");
    $("#sync-badge").innerHTML =
      '<i data-lucide="cloud"></i> Sincronizado';
    $("#github-status").textContent = updatedAt
      ? `Último ciclo: ${formatDateTime(updatedAt)}.`
      : "Escáner gratuito programado.";
  }

  function priceText(monitor) {
    const joiner = monitor.priceMatch === "both" ? "y" : "o";
    return `${monitor.maxTotal || 0} € total ${joiner} ${monitor.maxNightly || 0} €/noche`;
  }

  function dateText(monitor) {
    if (monitor.dateMode === "fixed") {
      return `${formatDate(monitor.dateStart)} - ${formatDate(monitor.dateEnd)}`;
    }
    return `${monitor.minNights}-${monitor.maxNights} noches · ${monitor.windowDays} días`;
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
                      )} · cada ${escapeHtml(monitor.intervalMinutes)} min
                    </span>
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

  function renderDeals() {
    const deals = state.deals.deals || [];
    $("#deal-count").textContent = String(deals.length);
    $("#deals-table").innerHTML = deals.length
      ? `
        <div class="table-header">
          <span>Alojamiento</span>
          <span>Estancia</span>
          <span>Precio</span>
          <span>Calidad</span>
          <span></span>
        </div>
        ${deals
          .map(
            (deal) => `
              <article class="deal-row">
                <span>
                  <strong>${escapeHtml(deal.hotelName)}</strong>
                  <small>${escapeHtml(deal.monitorName || deal.location)}</small>
                </span>
                <span>
                  <strong>${escapeHtml(formatDate(deal.checkIn))}</strong>
                  <small>${escapeHtml(deal.nights)} noches</small>
                </span>
                <span class="deal-price">
                  <strong>${Number(deal.totalPrice).toFixed(0)} €</strong>
                  <small>${Number(deal.nightlyPrice).toFixed(2)} €/noche</small>
                </span>
                <span>
                  <strong>${deal.stars ? `${escapeHtml(deal.stars)} estrellas` : "Sin estrellas"}</strong>
                  <small>${deal.guestRating ? `Nota ${escapeHtml(deal.guestRating)}` : "Sin nota"}</small>
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
            `,
          )
          .join("")}
      `
      : `
        <div class="empty-state">
          <span><i data-lucide="radar"></i></span>
          <strong>Aún no hay coincidencias</strong>
          <p>Las ofertas aparecerán aquí después del siguiente ciclo.</p>
        </div>
      `;
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
    $("#source-grid").innerHTML = sources
      .map(
        ([id, label, automatic]) => `
          <span class="${automatic ? "automatic" : ""}">
            <span>${escapeHtml(label)}<small>${automatic ? "Automático" : "Enlace manual"}</small></span>
            <i data-lucide="${automatic ? "check" : "external-link"}"></i>
          </span>
        `,
      )
      .join("");
    refreshIcons();
  }

  function setDateMode(mode) {
    state.draft.dateMode = mode;
    $$("[data-date-mode]").forEach((button) => {
      button.classList.toggle("selected", button.dataset.dateMode === mode);
    });
    $("#flexible-fields").classList.toggle("hidden", mode !== "flexible");
    $("#fixed-fields").classList.toggle("hidden", mode !== "fixed");
    renderRulePreview();
  }

  function fillEditor() {
    const draft = state.draft;
    $("#editor-title").textContent = state.config.monitors.some(
      (monitor) => monitor.id === draft.id,
    )
      ? "Editar búsqueda"
      : "Nueva búsqueda";
    $("#editor-status").textContent = draft.active ? "Activa" : "Pausada";
    $("#editor-status").classList.toggle("ready", draft.active);
    $("#monitor-name").value = draft.name;
    $("#location-query").value = draft.location;
    $("#location-confirmed").innerHTML = draft.locationId
      ? `<i data-lucide="map-pin-check"></i> Ubicación detectada · ${escapeHtml(
          draft.countryCode || "",
        )}`
      : "";
    $("#min-nights").value = draft.minNights;
    $("#max-nights").value = draft.maxNights;
    $("#window-days").value = String(draft.windowDays);
    $("#date-start").value = draft.dateStart || "";
    $("#date-end").value = draft.dateEnd || "";
    $("#max-total").value = draft.maxTotal;
    $("#max-nightly").value = draft.maxNightly;
    $("#price-match").value = draft.priceMatch;
    $("#guest-rating").value = String(draft.guestRatingMin);
    $("#max-distance").value = String(draft.maxDistanceKm);
    $("#free-cancellation").checked = draft.freeCancellation;
    $("#meal-plan").value = draft.mealPlan;
    $("#adults").value = draft.adults;
    $("#children").value = draft.children;
    $("#rooms").value = draft.rooms;
    $("#interval-minutes").value = String(draft.intervalMinutes);
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
    draft.active = $("#monitor-active").checked;
    draft.sources = ["booking"];
  }

  function renderRulePreview() {
    syncDraftFromInputs();
    const draft = state.draft;
    const stars = draft.minStars ? `${draft.minStars}+ estrellas` : "con o sin estrellas";
    const dates =
      draft.dateMode === "fixed"
        ? `${draft.dateStart || "entrada"} a ${draft.dateEnd || "salida"}`
        : `${draft.minNights}-${draft.maxNights} noches`;
    $("#rule-preview").innerHTML = `
      <span><i data-lucide="radar"></i></span>
      <div>
        <strong>${escapeHtml(draft.location || "Destino")} · ${escapeHtml(dates)}</strong>
        <p>${escapeHtml(priceText(draft))} · ${escapeHtml(stars)} · Booking automático</p>
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
    const query = encodeURIComponent(
      `${monitor.location} hotel ${monitor.minNights} noches`,
    );
    return [
      [
        "Booking",
        `https://www.booking.com/searchresults.es.html?ss=${encoded}${bookingDates}`,
      ],
      ["Google Hoteles", `https://www.google.com/travel/search?q=${query}`],
      ["Trivago", `https://www.trivago.es/es/srl?search=${encoded}`],
      ["KAYAK", `https://www.kayak.es/hotels/${encoded}`],
      [
        "Expedia",
        `https://www.expedia.es/Hotel-Search?destination=${encoded}${bookingDates}`,
      ],
      [
        "Hotels.com",
        `https://www.hotels.com/Hotel-Search?destination=${encoded}${bookingDates}`,
      ],
      ["Agoda", `https://www.agoda.com/es-es/search?textToSearch=${encoded}`],
      ["Trip.com", `https://es.trip.com/hotels/list?city=${encoded}`],
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
    if (draft.dateMode === "fixed") {
      if (!draft.dateStart || !draft.dateEnd) {
        return "Selecciona las fechas de entrada y salida.";
      }
      const nights = nightsBetween(draft.dateStart, draft.dateEnd);
      if (nights < 1) return "La salida debe ser posterior a la entrada.";
      draft.minNights = nights;
      draft.maxNights = nights;
    } else if (draft.maxNights < draft.minNights) {
      return "Las noches máximas no pueden ser menores que las mínimas.";
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
      showToast("Búsqueda guardada. El próximo ciclo empezará en unos minutos.");
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

  async function searchLocations(query) {
    const response = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        query,
      )}&count=8&language=es&format=json`,
    );
    if (!response.ok) throw new Error("No se pudo consultar el destino.");
    const payload = await response.json();
    state.locationResults = (payload.results || []).map((item) => ({
      id: String(item.id),
      name: item.name,
      label: [item.name, item.admin1, item.country].filter(Boolean).join(", "),
      details: [item.admin2, item.admin3].filter(Boolean).join(" · "),
      latitude: item.latitude,
      longitude: item.longitude,
      countryCode: item.country_code || "",
      featureCode: item.feature_code || "",
    }));
    renderLocationResults();
  }

  function renderLocationResults() {
    const container = $("#location-results");
    container.innerHTML = state.locationResults
      .map(
        (location, index) => `
          <button class="location-option" type="button" data-location-index="${index}">
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
        state.draft.location = location.label;
        state.draft.locationId = location.id;
        state.draft.latitude = location.latitude;
        state.draft.longitude = location.longitude;
        state.draft.countryCode = location.countryCode;
        $("#location-query").value = location.label;
        $("#location-confirmed").innerHTML = `<i data-lucide="map-pin-check"></i> Ubicación detectada · ${escapeHtml(
          location.countryCode,
        )}`;
        container.classList.add("hidden");
        renderRulePreview();
        renderManualLinks();
        refreshIcons();
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
    $("#location-confirmed").textContent = "";
    clearTimeout(state.locationTimer);
    if (value.length < 2) {
      state.locationResults = [];
      renderLocationResults();
      return;
    }
    state.locationTimer = setTimeout(() => {
      searchLocations(value).catch((error) => {
        $("#form-error").textContent = error.message;
      });
    }, 350);
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

  function showApp() {
    $("#login-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
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
    $("#location-query").addEventListener("input", handleLocationInput);
    $("#location-query").addEventListener("blur", () => {
      setTimeout(() => $("#location-results").classList.add("hidden"), 180);
    });
    $$("[data-date-mode]").forEach((button) => {
      button.addEventListener("click", () => setDateMode(button.dataset.dateMode));
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
