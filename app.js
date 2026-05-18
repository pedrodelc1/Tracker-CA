// ─── Constantes ───────────────────────────────────────────────────────────────
const MIS_ENVIOS_URL  = "https://www.correoargentino.com.ar/MiCorreo/public/mis-envios";
const PAGADOS_URL     = "https://www.correoargentino.com.ar/MiCorreo/public/listadooperaciones";
const PAGADOS_API_URL = "https://www.correoargentino.com.ar/MiCorreo/public/qlistadoget_operaciones";
const SEGUIMIENTO_URL = (n) => `https://www.correoargentino.com.ar/MiCorreo/public/seguimiento?numero=${n}`;

const STATUS_MAP = {
  ready:        { text: "Listo para retirar",    cssClass: "status-ready",        badgeClass: "badge-ready"        },
  delivered:    { text: "Entregado",             cssClass: "status-delivered",    badgeClass: "badge-delivered"    },
  attempted:    { text: "Intento de entrega",    cssClass: "status-attempted",    badgeClass: "badge-attempted"    },
  distributor:  { text: "Con distribuidor",      cssClass: "status-distributor",  badgeClass: "badge-distributor"  },
  transit:      { text: "En camino",             cssClass: "status-transit",      badgeClass: "badge-transit"      },
  sorting:      { text: "Clasificando",          cssClass: "status-sorting",      badgeClass: "badge-sorting"      },
  preimposed:   { text: "Preimposición",         cssClass: "status-preimposed",   badgeClass: "badge-preimposed"   },
  admitted:     { text: "Admitido",              cssClass: "status-admitted",     badgeClass: "badge-admitted"     },
  preparing:    { text: "Preparando",            cssClass: "status-preparing",    badgeClass: "badge-preparing"    },
  validated:    { text: "Validado",              cssClass: "status-validated",    badgeClass: "badge-validated"    },
  process:      { text: "En proceso",            cssClass: "status-process",      badgeClass: "badge-process"      },
  returned:     { text: "Devuelto",              cssClass: "status-returned",     badgeClass: "badge-returned"     },
  cancelled:    { text: "Cancelado",             cssClass: "status-cancelled",    badgeClass: "badge-cancelled"    },
};

const STATUS_PRIORITY = {
  ready: 0, delivered: 1, attempted: 2, distributor: 3, transit: 4,
  sorting: 5, preimposed: 6, admitted: 7, preparing: 8,
  validated: 9, process: 10, returned: 11, cancelled: 12,
};

// Orden importa: los más específicos primero
const STATUS_KEYWORDS = [
  ["ready",       ["listo para retirar", "disponible para retiro"]],
  ["delivered",   ["entregado"]],
  ["attempted",   ["intento de entrega"]],
  ["distributor", ["en poder del distribuidor", "en poder de distribuidor"]],
  ["transit",     ["en camino", "en distribución", "en reparto", "en tránsito", "salió para", "en viaje", "distribucion"]],
  ["sorting",     ["clasificaci", "proceso de clasificac", "en clasificac"]],
  ["preimposed",  ["preimposici", "preimpos"]],
  ["admitted",    ["admitido", "recibido en"]],
  ["preparing",   ["preparando", "en preparación", "generado", "en proceso de"]],
  ["validated",   ["validado"]],
  ["returned",    ["devuelto", "retornado"]],
  ["cancelled",   ["cancelado", "rechazado", "anulado"]],
];

function normalizeStatus(raw = "") {
  const s = raw.toLowerCase().trim();
  for (const [key, kws] of STATUS_KEYWORDS) {
    if (kws.some(kw => s.includes(kw))) return key;
  }
  return "process";
}

// ─── Estado ───────────────────────────────────────────────────────────────────
let packages  = [];
let activeTab = "pendientes";
let searchQuery = "";
let sortBy    = "status";

// ─── Storage ──────────────────────────────────────────────────────────────────
function loadStorage() {
  return new Promise(r => chrome.storage.local.get(["packages"], d => r(d.packages || [])));
}
function saveStorage() {
  return new Promise(r => chrome.storage.local.set({ packages }, r));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getCellText(td) {
  if (!td) return "";
  const div = td.querySelector("div");
  return (div ? div.textContent : td.textContent).trim();
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(raw) {
  if (!raw) return "";
  try {
    const d = new Date(raw);
    if (isNaN(d)) return raw;
    return d.toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return raw; }
}

function formatHistoryDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

// ─── Session check via cookie (more reliable than URL/HTML heuristics) ────────
async function isLoggedIn() {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ domain: "correoargentino.com.ar" }, (cookies) => {
      console.log("[CorreoTracker] cookies encontradas:", cookies.map(c => c.name));
      resolve(cookies.length > 0);
    });
  });
}

// ─── Fetch Pendientes ─────────────────────────────────────────────────────────
async function fetchShipments() {
  const loggedIn = await isLoggedIn();
  if (!loggedIn) return { error: "not_logged_in" };

  let resp;
  try {
    resp = await fetch(MIS_ENVIOS_URL, { credentials: "include" });
  } catch (e) { return { error: "network_error" }; }

  if (!resp.ok) return { error: "network_error" };

  const html = await resp.text();
  const doc  = new DOMParser().parseFromString(html, "text/html");

  // Only treat as logged-out if the page URL explicitly redirected to login
  if (resp.url.includes("/login") && !resp.url.includes("mis-envios")) {
    return { error: "not_logged_in" };
  }

  let rows = doc.querySelectorAll("table.mcr-table tbody tr");
  if (!rows.length) rows = doc.querySelectorAll("#divListado .dvEnvios table tbody tr");
  if (!rows.length) rows = doc.querySelectorAll(".dvEnvios table tbody tr");
  if (!rows.length) rows = doc.querySelectorAll("table.table-hover tbody tr");
  if (!rows.length) return { data: [] };

  const shipments = [];
  rows.forEach((row, idx) => {
    const tds = Array.from(row.querySelectorAll("td"));
    if (tds.length < 5) return;
    const nOrden       = getCellText(tds[3]);
    const origen       = getCellText(tds[4]);
    const destinatario = getCellText(tds[5]);
    const entrega      = getCellText(tds[6]);
    const detalles     = getCellText(tds[7]);
    const rawStatus    = getCellText(tds[tds.length - 1]);
    const trackingId   = (nOrden && nOrden !== "-" && nOrden !== "")
      ? nOrden
      : `envio-${origen}-${destinatario}-${idx}`.replace(/\s+/g, "_");
    shipments.push({
      tracking: trackingId, label: destinatario || `Envío ${idx + 1}`,
      origen, destinatario, entrega, detalles,
      status: normalizeStatus(rawStatus), rawStatus, lastDate: "", source: "auto",
    });
  });
  return { data: shipments };
}

// ─── Fetch Pagados ────────────────────────────────────────────────────────────
async function getCsrfToken() {
  // Laravel sets XSRF-TOKEN as a cookie — more reliable than scraping HTML
  return new Promise((resolve) => {
    chrome.cookies.get(
      { url: "https://www.correoargentino.com.ar", name: "XSRF-TOKEN" },
      (cookie) => resolve(cookie ? decodeURIComponent(cookie.value) : null)
    );
  });
}

async function fetchPagados() {
  // Verify session is active before fetching
  let pageResp;
  try {
    pageResp = await fetch(PAGADOS_URL, { credentials: "include" });
  } catch { return []; }
  if (!pageResp.ok || pageResp.url.includes("login")) return [];

  const token = await getCsrfToken();

  if (!token) { fetchPagados._debug = "no_token"; return []; }

  let resp;
  try {
    const body = new URLSearchParams({
      _token: token, fdesde: "", fhasta: "", tn: "",
      provincia_orig: "", provincia_dest: "",
      sucu_orig: "", sucu_dest: "", destino_nombre: "",
      pag: "0", sortc: "FECHA_CREACION", sortr: "1",
    });
    resp = await fetch(PAGADOS_API_URL, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch { return []; }
  if (!resp.ok) return [];

  const html = await resp.text();
  const doc  = new DOMParser().parseFromString(html, "text/html");

  let rows = doc.querySelectorAll("#pendientes .panel-default table tbody tr");
  if (!rows.length) rows = doc.querySelectorAll("#pendientes table tbody tr");
  if (!rows.length) rows = doc.querySelectorAll("#myTabContent table tbody tr");
  if (!rows.length) rows = doc.querySelectorAll("table tbody tr");

  fetchPagados._debug = `rows=${rows.length}`;

  const shipments = [];
  const TRACKING_RE = /^[0-9A-Z]{10,}$/;

  rows.forEach((row, idx) => {
    const tds = Array.from(row.querySelectorAll("td"));
    if (tds.length < 6) return;

    let tracking = "", trackingIdx = -1;
    for (let i = 0; i < tds.length; i++) {
      const clone = tds[i].cloneNode(true);
      clone.querySelectorAll("button, a, svg, i, span.sr-only").forEach(el => el.remove());
      const txt = clone.textContent.trim().replace(/\s+/g, "");
      if (TRACKING_RE.test(txt) && txt.length > 10) { tracking = txt; trackingIdx = i; break; }
    }
    if (!tracking) return;

    const fecha     = trackingIdx > 0 ? getCellText(tds[trackingIdx - 1]) : "";
    const origen    = getCellText(tds[trackingIdx + 1]);
    const dest      = getCellText(tds[trackingIdx + 2]);
    const provincia = getCellText(tds[trackingIdx + 3]);
    const rawStatus = getCellText(tds[tds.length - 1]);

    shipments.push({
      tracking, label: dest || `Envío ${idx + 1}`,
      origen, destinatario: dest, entrega: provincia,
      detalles: fecha ? `Fecha: ${fecha}` : "",
      status: normalizeStatus(rawStatus), rawStatus, lastDate: fecha, source: "pagado",
    });
  });
  return shipments;
}

// ─── Fetch tracking individual (manuales) ────────────────────────────────────
async function fetchTrackingStatus(trackingNumber) {
  try {
    const apiResp = await fetch(
      `https://api.correoargentino.com.ar/micorreo/v1/shipments/${trackingNumber}`,
      { credentials: "include" }
    );
    if (apiResp.ok) {
      const data = await apiResp.json();
      const raw  = data.estadoDescripcion || data.status || data.estado || "";
      if (raw) return { rawStatus: raw, status: normalizeStatus(raw) };
    }
  } catch {}
  try {
    const resp = await fetch(SEGUIMIENTO_URL(trackingNumber), { credentials: "include" });
    if (!resp.ok) return null;
    const html = await resp.text();
    const doc  = new DOMParser().parseFromString(html, "text/html");
    for (const sel of [".estado-envio", ".tracking-status", "[class*='estado']", "[class*='status']"]) {
      const el = doc.querySelector(sel);
      if (el) {
        const raw = el.textContent.trim();
        if (raw.length > 2 && raw.length < 80) return { rawStatus: raw, status: normalizeStatus(raw) };
      }
    }
  } catch {}
  return null;
}

// ─── Notificaciones ───────────────────────────────────────────────────────────
function notifyStatusChanges(oldMap, newPackages) {
  newPackages.forEach(p => {
    const oldStatus = oldMap[p.tracking];
    if (!oldStatus || oldStatus === p.status) return;
    const st = STATUS_MAP[p.status] || STATUS_MAP.process;
    chrome.notifications.create(`status-${p.tracking}-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon48.png"),
      title: "📦 Estado actualizado",
      message: `${p.label}: ${st.emoji} ${st.text}`,
    });
  });
}

// ─── Historial de estados ─────────────────────────────────────────────────────
function mergeFromStored(storedMap, pkg) {
  const old = storedMap[pkg.tracking];
  if (!old) return;
  if (old.customLabel) { pkg.label = old.customLabel; pkg.customLabel = old.customLabel; }
  if (old.notes) pkg.notes = old.notes;
  pkg.history = old.history || [];
  if (old.status && old.status !== pkg.status) {
    pkg.history = [
      ...pkg.history,
      { status: old.status, rawStatus: old.rawStatus || "", date: new Date().toISOString() },
    ].slice(-10);
  }
}

// ─── Filtrar y ordenar ────────────────────────────────────────────────────────
function getVisiblePackages() {
  const sourceMap = { pendientes: "auto", pagados: "pagado", manuales: "manual" };
  let visible = packages.filter(p => p.source === sourceMap[activeTab]);

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    visible = visible.filter(p =>
      (p.label || "").toLowerCase().includes(q) ||
      (p.tracking || "").toLowerCase().includes(q) ||
      (p.destinatario || "").toLowerCase().includes(q) ||
      (p.entrega || "").toLowerCase().includes(q)
    );
  }

  visible.sort((a, b) => {
    if (sortBy === "status") return (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9);
    if (sortBy === "name")   return (a.label || "").localeCompare(b.label || "", "es");
    if (sortBy === "date")   return new Date(b.lastDate || 0) - new Date(a.lastDate || 0);
    return 0;
  });

  return visible;
}

// ─── Exportar CSV ─────────────────────────────────────────────────────────────
function exportCSV() {
  const BOM  = "﻿";
  const cols = ["Tracking", "Nombre", "Estado", "Descripción", "Origen", "Entrega", "Detalles", "Nota", "Fuente"];
  const rows = packages.map(p => [
    p.tracking, p.label,
    STATUS_MAP[p.status]?.text || p.status,
    p.rawStatus || "", p.origen || "", p.entrega || "", p.detalles || "",
    p.notes || "", p.source,
  ]);
  const csv  = BOM + [cols, ...rows]
    .map(r => r.map(v => `"${String(v || "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const url  = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `correo-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Render ───────────────────────────────────────────────────────────────────
function updateTabCounts() {
  const c = { auto: 0, pagado: 0, manual: 0 };
  packages.forEach(p => { if (c[p.source] !== undefined) c[p.source]++; });
  document.getElementById("countPendientes").textContent = c.auto   || "";
  document.getElementById("countPagados").textContent    = c.pagado || "";
  document.getElementById("countManuales").textContent   = c.manual || "";
}

function renderCards() {
  const grid    = document.getElementById("cardsGrid");
  const empty   = document.getElementById("emptyState");
  const visible = getVisiblePackages();

  updateTabCounts();

  if (visible.length === 0) {
    grid.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  grid.innerHTML = "";

  visible.forEach(pkg => {
    const st   = STATUS_MAP[pkg.status] || STATUS_MAP.process;
    const card = document.createElement("div");
    card.className = `card ${st.cssClass}`;
    card.dataset.tracking = pkg.tracking;

    const historyHtml = pkg.history?.length ? `
      <details class="card-history">
        <summary>Historial (${pkg.history.length})</summary>
        ${[...pkg.history].reverse().map(h => {
          const hs = STATUS_MAP[h.status] || STATUS_MAP.process;
          return `<div class="history-item">
            <span class="history-dot ${hs.badgeClass}"></span>${escapeHtml(h.rawStatus || hs.text)}
            <span class="history-date">${formatHistoryDate(h.date)}</span>
          </div>`;
        }).join("")}
      </details>` : "";

    card.innerHTML = `
      <button class="card-delete" data-tracking="${escapeHtml(pkg.tracking)}" title="Eliminar">✕</button>
      ${(pkg.source === "manual" || pkg.source === "pagado") ? `<div class="card-tracking">${escapeHtml(pkg.tracking)}</div>` : ""}
      ${pkg.source === "pagado" ? `<span class="card-tab-badge">Pagado</span>` : ""}
      <input class="card-label" type="text" value="${escapeHtml(pkg.label)}"
             data-tracking="${escapeHtml(pkg.tracking)}" placeholder="Sin nombre" />
      <div class="card-badge ${st.badgeClass}"><span class="badge-dot"></span>${st.text}</div>
      ${pkg.rawStatus && pkg.rawStatus.toLowerCase() !== (STATUS_MAP[pkg.status]?.text || "").toLowerCase()
          ? `<div class="card-raw-status">${escapeHtml(pkg.rawStatus)}</div>` : ""}
      ${pkg.origen  ? `<div class="card-meta">📍 ${escapeHtml(pkg.origen)}</div>`  : ""}
      ${pkg.entrega ? `<div class="card-meta">🏠 ${escapeHtml(pkg.entrega)}</div>` : ""}
      ${pkg.detalles? `<div class="card-meta">📦 ${escapeHtml(pkg.detalles)}</div>`: ""}
      ${historyHtml}
      <div class="card-notes-toggle" data-tracking="${escapeHtml(pkg.tracking)}">
        📝 ${pkg.notes ? "Ver nota" : "Agregar nota"}
      </div>
      <textarea class="card-notes ${pkg.notes ? "visible" : ""}" data-tracking="${escapeHtml(pkg.tracking)}"
        placeholder="Escribí una nota...">${escapeHtml(pkg.notes || "")}</textarea>
      ${pkg.loading ? `<div class="card-loading">Actualizando...</div>` : ""}
    `;
    grid.appendChild(card);
  });
}

function setLastUpdated() {
  const now = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  document.getElementById("lastUpdated").textContent = `Actualizado ${now}`;
}

function showInfo(msg) {
  document.getElementById("noticeInfoText").textContent = msg;
  document.getElementById("noticeInfo").style.display = "flex";
}

// ─── Lógica principal ─────────────────────────────────────────────────────────
async function loadAndRender() {
  document.getElementById("loadingState").style.display = "block";
  document.getElementById("emptyState").style.display   = "none";
  document.getElementById("cardsGrid").innerHTML        = "";
  document.getElementById("noticeLogin").style.display  = "none";
  document.getElementById("noticeInfo").style.display   = "none";

  const saved  = await loadStorage();
  const [result, pagados] = await Promise.all([fetchShipments(), fetchPagados()]);

  if (result.error === "not_logged_in") {
    document.getElementById("noticeLogin").style.display = "flex";
    packages = saved;
    document.getElementById("loadingState").style.display = "none";
    renderCards();
    return;
  }
  if (result.error) {
    showInfo(`Error de red (${result.error}). Mostrando pedidos guardados.`);
    packages = saved;
    document.getElementById("loadingState").style.display = "none";
    renderCards();
    return;
  }

  const autoPackages = result.data || [];
  const storedMap    = {};
  saved.forEach(p => storedMap[p.tracking] = p);

  // Snapshot de estados anteriores para notificaciones
  const oldStatusMap = {};
  saved.forEach(p => oldStatusMap[p.tracking] = p.status);

  // Fusionar datos auto + pagados
  const autoIds     = new Set(autoPackages.map(p => p.tracking));
  const pagadosUniq = pagados.filter(p => !autoIds.has(p.tracking));
  const allAutoIds  = new Set([...autoPackages, ...pagadosUniq].map(p => p.tracking));
  const manuals     = saved.filter(p => p.source === "manual" && !allAutoIds.has(p.tracking));

  packages = [...autoPackages, ...pagadosUniq, ...manuals];

  // Aplicar datos guardados (labels, notas, historial)
  packages.forEach(p => mergeFromStored(storedMap, p));

  // Notificar cambios de estado
  notifyStatusChanges(oldStatusMap, packages);

  if (pagadosUniq.length === 0 && fetchPagados._debug) {
    showInfo(`Pagados: ${fetchPagados._debug === "no_token" ? "no se encontró token CSRF" : `no se encontraron envíos (${fetchPagados._debug})`}`);
  }

  await saveStorage();
  document.getElementById("loadingState").style.display = "none";
  renderCards();
  setLastUpdated();
}

async function refreshAll() {
  const btn = document.getElementById("btnRefresh");
  btn.disabled = true; btn.textContent = "Actualizando...";

  const manuals = packages.filter(p => p.source === "manual");
  manuals.forEach(p => { p.loading = true; });
  if (manuals.length) renderCards();

  await Promise.all(manuals.map(async (pkg) => {
    const result = await fetchTrackingStatus(pkg.tracking);
    if (result) { pkg.status = result.status; pkg.rawStatus = result.rawStatus; }
    pkg.loading = false;
  }));

  await loadAndRender();
  btn.disabled = false; btn.textContent = "↻ Actualizar";
}

// ─── Eventos: grid ────────────────────────────────────────────────────────────
document.getElementById("cardsGrid").addEventListener("click", async (e) => {
  const toggle = e.target.closest(".card-notes-toggle");
  if (toggle) {
    const textarea = toggle.nextElementSibling;
    const isOpen   = textarea.classList.toggle("visible");
    toggle.textContent = isOpen
      ? `📝 ${textarea.value ? "Ver nota" : "Agregar nota"}`
      : `📝 ${textarea.value ? "Ver nota" : "Agregar nota"}`;
    if (isOpen) textarea.focus();
    return;
  }

  const del = e.target.closest(".card-delete");
  if (!del) return;
  const idx = packages.findIndex(p => p.tracking === del.dataset.tracking);
  if (idx === -1) return;
  packages.splice(idx, 1);
  await saveStorage();
  renderCards();
});

document.getElementById("cardsGrid").addEventListener("change", async (e) => {
  const label = e.target.closest(".card-label");
  const notes = e.target.closest(".card-notes");
  if (label) {
    const pkg = packages.find(p => p.tracking === label.dataset.tracking);
    if (pkg) { pkg.label = label.value; pkg.customLabel = label.value; await saveStorage(); }
  }
  if (notes) {
    const pkg = packages.find(p => p.tracking === notes.dataset.tracking);
    if (pkg) { pkg.notes = notes.value; await saveStorage(); }
  }
});

// ─── Toolbar: búsqueda y orden ────────────────────────────────────────────────
document.getElementById("searchInput").addEventListener("input", (e) => {
  searchQuery = e.target.value.trim();
  renderCards();
});

document.getElementById("sortSelect").addEventListener("change", (e) => {
  sortBy = e.target.value;
  renderCards();
});

// ─── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    document.getElementById("searchInput").value = "";
    searchQuery = "";
    renderCards();
  });
});

// ─── Botones header ───────────────────────────────────────────────────────────
document.getElementById("btnRefresh").addEventListener("click", refreshAll);
document.getElementById("btnExport").addEventListener("click", exportCSV);
document.getElementById("btnLogin").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.correoargentino.com.ar/MiCorreo/public/login" });
});
document.getElementById("btnCloseInfo").addEventListener("click", () => {
  document.getElementById("noticeInfo").style.display = "none";
});

// ─── Modal ────────────────────────────────────────────────────────────────────
document.getElementById("btnAddManual").addEventListener("click", () => {
  document.getElementById("inputTracking").value = "";
  document.getElementById("inputLabel").value    = "";
  document.getElementById("inputNote").value     = "";
  document.getElementById("modalOverlay").style.display = "flex";
  setTimeout(() => document.getElementById("inputTracking").focus(), 50);
});

document.getElementById("btnModalCancel").addEventListener("click", () => {
  document.getElementById("modalOverlay").style.display = "none";
});

document.getElementById("btnModalAdd").addEventListener("click", async () => {
  const tracking = document.getElementById("inputTracking").value.trim();
  const label    = document.getElementById("inputLabel").value.trim();
  const note     = document.getElementById("inputNote").value.trim();

  if (!tracking) { document.getElementById("inputTracking").focus(); return; }
  if (packages.some(p => p.tracking === tracking)) { alert("Ese tracking ya existe."); return; }

  const pkg = {
    tracking, label: label || tracking, customLabel: label || "",
    notes: note, status: "process", rawStatus: "Consultando...",
    loading: true, source: "manual", history: [],
  };
  packages.unshift(pkg);
  await saveStorage();
  renderCards();
  document.getElementById("modalOverlay").style.display = "none";

  const result = await fetchTrackingStatus(tracking);
  if (result) { pkg.status = result.status; pkg.rawStatus = result.rawStatus; }
  else        { pkg.rawStatus = ""; }
  pkg.loading = false;
  await saveStorage();
  renderCards();
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") document.getElementById("modalOverlay").style.display = "none";
});

// ─── Auto-refresh desde background ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "auto-refresh") refreshAll();
});

// ─── Tema oscuro/claro ────────────────────────────────────────────────────────
function applyTheme(dark) {
  document.body.dataset.theme = dark ? "dark" : "";
  document.getElementById("btnTheme").textContent = dark ? "☀️" : "🌙";
}

chrome.storage.local.get(["darkMode"], ({ darkMode }) => applyTheme(!!darkMode));

document.getElementById("btnTheme").addEventListener("click", () => {
  const isDark = document.body.dataset.theme === "dark";
  applyTheme(!isDark);
  chrome.storage.local.set({ darkMode: !isDark });
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadAndRender();
