// ─── Constantes ───────────────────────────────────────────────────────────────
const MIS_ENVIOS_URL  = "https://www.correoargentino.com.ar/MiCorreo/public/mis-envios";
const PAGADOS_URL     = "https://www.correoargentino.com.ar/MiCorreo/public/listadooperaciones";
const SEGUIMIENTO_URL = (n) => `https://www.correoargentino.com.ar/MiCorreo/public/seguimiento?numero=${n}`;

const STATUS_MAP = {
  ready:     { emoji: "🟢", text: "LISTO PARA RETIRAR", cssClass: "status-ready",     badgeClass: "badge-ready"     },
  transit:   { emoji: "🟡", text: "EN CAMINO",           cssClass: "status-transit",   badgeClass: "badge-transit"   },
  preparing: { emoji: "🔵", text: "PREPARANDO",          cssClass: "status-preparing", badgeClass: "badge-preparing" },
  process:   { emoji: "⚪", text: "EN PROCESO",           cssClass: "status-process",   badgeClass: "badge-process"   },
  cancelled: { emoji: "🔴", text: "CANCELADO",           cssClass: "status-cancelled", badgeClass: "badge-cancelled" },
};

const STATUS_KEYWORDS = {
  ready:     ["listo para retirar", "disponible", "entregado"],
  transit:   ["en camino", "en distribución", "en reparto", "en tránsito", "salió", "distribucion",
              "en poder del distribuidor", "intento de entrega", "en camino a"],
  preparing: ["preparando", "admitido", "en preparación", "en proceso de", "validado", "generado",
              "clasificaci", "en proceso"],
  cancelled: ["cancelado", "devuelto", "rechazado", "anulado"],
};

function normalizeStatus(raw = "") {
  const s = raw.toLowerCase().trim();
  for (const [key, kws] of Object.entries(STATUS_KEYWORDS)) {
    if (kws.some(kw => s.includes(kw))) return key;
  }
  return "process";
}

// ─── Estado en memoria ────────────────────────────────────────────────────────
let packages = [];

// ─── Storage ──────────────────────────────────────────────────────────────────
function loadStorage() {
  return new Promise(r => chrome.storage.local.get(["packages"], d => r(d.packages || [])));
}

function saveStorage() {
  return new Promise(r => chrome.storage.local.set({ packages }, r));
}

// ─── Fetch tabla de MiCorreo ──────────────────────────────────────────────────
function getCellText(td) {
  if (!td) return "";
  const div = td.querySelector("div");
  return (div ? div.textContent : td.textContent).trim();
}

async function fetchShipments() {
  let resp;
  try {
    resp = await fetch(MIS_ENVIOS_URL, { credentials: "include" });
  } catch (e) {
    return { error: "network_error", message: e.message };
  }

  if (!resp.ok || resp.url.includes("login") || resp.url.includes("acceso")) {
    return { error: "not_logged_in" };
  }

  const html = await resp.text();
  const doc  = new DOMParser().parseFromString(html, "text/html");

  const loginForm = doc.querySelector("form[action*='login'], input[name='username'], input[name='j_username']");
  if (loginForm) return { error: "not_logged_in" };

  // Intentar con selector principal, luego fallback
  let rows = doc.querySelectorAll("table.mcr-table tbody tr");
  if (!rows.length) rows = doc.querySelectorAll("#divListado .dvEnvios table tbody tr");
  if (!rows.length) rows = doc.querySelectorAll(".dvEnvios table tbody tr");
  if (!rows.length) rows = doc.querySelectorAll("table.table-hover tbody tr");

  // Si sigue sin filas, la sesión expiró sin redirigir
  if (!rows.length) return { error: "not_logged_in" };

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

    const trackingId = (nOrden && nOrden !== "-" && nOrden !== "")
      ? nOrden
      : `envio-${origen}-${destinatario}-${idx}`.replace(/\s+/g, "_");

    shipments.push({
      tracking: trackingId,
      label: destinatario || `Envío ${idx + 1}`,
      origen, destinatario, entrega, detalles,
      status:    normalizeStatus(rawStatus),
      rawStatus,
      lastDate:  "",
      source:    "auto",
    });
  });

  return { data: shipments };
}

// ─── Fetch Pagados (listadooperaciones) ───────────────────────────────────────
async function fetchPagados() {
  let resp;
  try {
    resp = await fetch(PAGADOS_URL, { credentials: "include" });
  } catch { return []; }

  if (!resp.ok || resp.url.includes("login")) return [];

  const html = await resp.text();
  const doc  = new DOMParser().parseFromString(html, "text/html");

  // Buscar la tabla dentro del tab #pendientes > panel panel-default (Current Envios)
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

    // Detectar la celda de seguimiento por patrón en lugar de índice fijo
    let tracking = "";
    let trackingIdx = -1;
    for (let i = 0; i < tds.length; i++) {
      const txt = (tds[i].firstChild?.textContent || tds[i].textContent).trim().replace(/\s+/g, "");
      if (TRACKING_RE.test(txt) && txt.length > 10) {
        tracking    = txt;
        trackingIdx = i;
        break;
      }
    }

    if (!tracking) return;

    const fecha     = trackingIdx > 0 ? getCellText(tds[trackingIdx - 1]) : "";
    const origen    = getCellText(tds[trackingIdx + 1]);
    const dest      = getCellText(tds[trackingIdx + 2]);
    const provincia = getCellText(tds[trackingIdx + 3]);
    const rawStatus = getCellText(tds[tds.length - 1]);

    shipments.push({
      tracking,
      label:        dest || `Envío ${idx + 1}`,
      origen,
      destinatario: dest,
      entrega:      provincia,
      detalles:     fecha ? `Fecha: ${fecha}` : "",
      status:       normalizeStatus(rawStatus),
      rawStatus,
      lastDate:     fecha,
      source:       "pagado",
    });
  });

  return shipments;
}

// ─── Fetch estado de tracking individual (para manuales) ──────────────────────
async function fetchTrackingStatus(trackingNumber) {
  try {
    // Intentar primero la API JSON
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
    // Fallback: parsear la página de seguimiento HTML
    const resp = await fetch(SEGUIMIENTO_URL(trackingNumber), { credentials: "include" });
    if (!resp.ok) return null;
    const html = await resp.text();
    const doc  = new DOMParser().parseFromString(html, "text/html");

    // Buscar el estado en distintos selectores posibles
    const selectors = [
      ".estado-envio", ".tracking-status", ".status-text",
      "[class*='estado']", "[class*='status']",
      "table tbody tr:last-child td:last-child",
    ];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) {
        const raw = el.textContent.trim();
        if (raw.length > 2 && raw.length < 80) {
          return { rawStatus: raw, status: normalizeStatus(raw) };
        }
      }
    }
  } catch {}

  return null;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderCards() {
  const grid  = document.getElementById("cardsGrid");
  const empty = document.getElementById("emptyState");

  if (packages.length === 0) {
    grid.innerHTML = "";
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  grid.innerHTML = "";

  packages.forEach((pkg, idx) => {
    const st   = STATUS_MAP[pkg.status] || STATUS_MAP.process;
    const card = document.createElement("div");
    card.className = `card ${st.cssClass}`;

    const extraLines = [
      pkg.origen     ? `<div class="card-meta">📍 Origen: ${escapeHtml(pkg.origen)}</div>`   : "",
      pkg.entrega    ? `<div class="card-meta">🏠 Entrega: ${escapeHtml(pkg.entrega)}</div>` : "",
      pkg.detalles   ? `<div class="card-meta">📦 ${escapeHtml(pkg.detalles)}</div>`          : "",
    ].join("");

    card.innerHTML = `
      <button class="card-delete" data-idx="${idx}" title="Eliminar">✕</button>
      ${pkg.source === "manual" ? `<div class="card-tracking">${escapeHtml(pkg.tracking)}</div>` : ""}
      ${pkg.source === "pagado" ? `<div class="card-tracking">${escapeHtml(pkg.tracking)}</div><span class="card-tab-badge">Pagado</span>` : ""}
      <input class="card-label" type="text" value="${escapeHtml(pkg.label)}"
             data-idx="${idx}" placeholder="Sin nombre" />
      <div class="card-badge ${st.badgeClass}">${st.emoji} ${st.text}</div>
      ${pkg.rawStatus ? `<div class="card-raw-status">${escapeHtml(pkg.rawStatus)}</div>` : ""}
      ${extraLines}
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
  const el = document.getElementById("noticeInfo");
  document.getElementById("noticeInfoText").textContent = msg;
  el.style.display = "flex";
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

  // Restaurar labels personalizados
  const labelMap = {};
  saved.forEach(p => { if (p.customLabel) labelMap[p.tracking] = p.customLabel; });
  [...autoPackages, ...pagados].forEach(p => {
    if (labelMap[p.tracking]) { p.label = labelMap[p.tracking]; p.customLabel = labelMap[p.tracking]; }
  });

  // Deduplicar pagados vs pendientes por tracking
  const autoIds   = new Set(autoPackages.map(p => p.tracking));
  const pagadosUniq = pagados.filter(p => !autoIds.has(p.tracking));
  const allAutoIds  = new Set([...autoPackages, ...pagadosUniq].map(p => p.tracking));
  const manuals   = saved.filter(p => p.source === "manual" && !allAutoIds.has(p.tracking));

  packages = [...autoPackages, ...pagadosUniq, ...manuals];
  if (pagadosUniq.length === 0) showInfo(`Pagados: no se encontraron envíos (debug: ${fetchPagados._debug})`);
  await saveStorage();

  document.getElementById("loadingState").style.display = "none";
  renderCards();
  setLastUpdated();
}

async function refreshAll() {
  const btn = document.getElementById("btnRefresh");
  btn.disabled = true;
  btn.textContent = "Actualizando...";

  // Actualizar estado de los manuales en paralelo
  const manuals = packages.filter(p => p.source === "manual");
  manuals.forEach(p => { p.loading = true; });
  if (manuals.length) renderCards();

  await Promise.all(manuals.map(async (pkg) => {
    const result = await fetchTrackingStatus(pkg.tracking);
    if (result) {
      pkg.status    = result.status;
      pkg.rawStatus = result.rawStatus;
    }
    pkg.loading = false;
  }));

  await loadAndRender();

  btn.disabled = false;
  btn.textContent = "↻ Actualizar todos";
}

// ─── Eventos: grid ────────────────────────────────────────────────────────────
document.getElementById("cardsGrid").addEventListener("click", async (e) => {
  const del = e.target.closest(".card-delete");
  if (!del) return;
  packages.splice(Number(del.dataset.idx), 1);
  await saveStorage();
  renderCards();
});

document.getElementById("cardsGrid").addEventListener("change", async (e) => {
  if (!e.target.classList.contains("card-label")) return;
  const idx = Number(e.target.dataset.idx);
  packages[idx].label       = e.target.value;
  packages[idx].customLabel = e.target.value;
  await saveStorage();
});

// ─── Botones ──────────────────────────────────────────────────────────────────
document.getElementById("btnRefresh").addEventListener("click", refreshAll);

document.getElementById("btnLogin").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.correoargentino.com.ar/MiCorreo/public/login" });
});

// ─── Modal: agregar tracking manual ──────────────────────────────────────────
document.getElementById("btnAddManual").addEventListener("click", () => {
  document.getElementById("inputTracking").value = "";
  document.getElementById("inputLabel").value    = "";
  document.getElementById("modalOverlay").style.display = "flex";
  setTimeout(() => document.getElementById("inputTracking").focus(), 50);
});

document.getElementById("btnModalCancel").addEventListener("click", () => {
  document.getElementById("modalOverlay").style.display = "none";
});

document.getElementById("btnModalAdd").addEventListener("click", async () => {
  const tracking = document.getElementById("inputTracking").value.trim();
  const label    = document.getElementById("inputLabel").value.trim();

  if (!tracking) { document.getElementById("inputTracking").focus(); return; }
  if (packages.some(p => p.tracking === tracking)) { alert("Ese tracking ya existe."); return; }

  const pkg = {
    tracking,
    label:       label || tracking,
    customLabel: label || "",
    status:      "process",
    rawStatus:   "Consultando...",
    loading:     true,
    source:      "manual",
  };

  packages.unshift(pkg);
  await saveStorage();
  renderCards();
  document.getElementById("modalOverlay").style.display = "none";

  // Consultar estado inmediatamente
  const result = await fetchTrackingStatus(tracking);
  if (result) {
    pkg.status    = result.status;
    pkg.rawStatus = result.rawStatus;
  } else {
    pkg.rawStatus = "";
  }
  pkg.loading = false;
  await saveStorage();
  renderCards();
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") document.getElementById("modalOverlay").style.display = "none";
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadAndRender();
