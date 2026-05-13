// ─── Constantes ───────────────────────────────────────────────────────────────
const MIS_ENVIOS_URL = "https://www.correoargentino.com.ar/MiCorreo/public/mis-envios";

const STATUS_MAP = {
  ready:     { emoji: "🟢", text: "LISTO PARA RETIRAR", cssClass: "status-ready",     badgeClass: "badge-ready"     },
  transit:   { emoji: "🟡", text: "EN CAMINO",           cssClass: "status-transit",   badgeClass: "badge-transit"   },
  preparing: { emoji: "🔵", text: "PREPARANDO",          cssClass: "status-preparing", badgeClass: "badge-preparing" },
  process:   { emoji: "⚪", text: "EN PROCESO",           cssClass: "status-process",   badgeClass: "badge-process"   },
  cancelled: { emoji: "🔴", text: "CANCELADO",           cssClass: "status-cancelled", badgeClass: "badge-cancelled" },
};

const STATUS_KEYWORDS = {
  ready:     ["listo para retirar", "disponible", "entregado"],
  transit:   ["en camino", "en distribución", "en reparto", "en tránsito", "salió", "distribucion"],
  preparing: ["preparando", "admitido", "en preparación", "en proceso de", "validado", "generado"],
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

// ─── Fetch y parseo del HTML ──────────────────────────────────────────────────
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

  // Si redirigió al login, la URL final cambia
  if (!resp.ok || resp.url.includes("login") || resp.url.includes("acceso")) {
    return { error: "not_logged_in" };
  }

  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Verificar que hay sesión activa buscando el saludo "Hola, ..."
  const loggedIn = doc.querySelector(".navbar-user, .user-name, [class*='usuario']");
  const loginForm = doc.querySelector("form[action*='login'], input[name='username'], input[name='j_username']");
  if (loginForm && !loggedIn) return { error: "not_logged_in" };

  // Seleccionar filas de la tabla de envíos
  // Estructura: table.mcr-table > tbody > tr
  const rows = doc.querySelectorAll("table.mcr-table tbody tr, #divListado .dvEnvios table tbody tr");

  if (rows.length === 0) {
    // Intentar selector genérico por si cambió la clase
    const altRows = doc.querySelectorAll(".dvEnvios tr, table.table-hover tbody tr");
    if (altRows.length === 0) return { error: "no_rows" };
  }

  const shipments = [];

  rows.forEach((row, idx) => {
    const tds = Array.from(row.querySelectorAll("td"));
    // La fila tiene: [id-envio, producto, integracion, nOrden, origen, destinatario, entrega, detalles, usuario, estado]
    // = 10 TDs (el checkbox es un TH, no TD)
    if (tds.length < 5) return;

    const last = tds.length - 1;

    const nOrden      = getCellText(tds[3]);
    const origen      = getCellText(tds[4]);
    const destinatario= getCellText(tds[5]);
    const entrega     = getCellText(tds[6]);
    const detalles    = getCellText(tds[7]);
    const rawStatus   = getCellText(tds[last]);

    // ID único: N° de orden si existe, sino combinación origen+destinatario
    const trackingId = (nOrden && nOrden !== "-" && nOrden !== "")
      ? nOrden
      : `envio-${origen}-${destinatario}-${idx}`.replace(/\s+/g, "_");

    shipments.push({
      tracking:     trackingId,
      label:        destinatario || `Envío ${idx + 1}`,
      origen,
      destinatario,
      entrega,
      detalles,
      status:       normalizeStatus(rawStatus),
      rawStatus,
      lastDate:     "",
      source:       "auto",
    });
  });

  return { data: shipments };
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
      pkg.origen      ? `<div class="card-meta">📍 Origen: ${escapeHtml(pkg.origen)}</div>` : "",
      pkg.entrega     ? `<div class="card-meta">🏠 Entrega: ${escapeHtml(pkg.entrega)}</div>` : "",
      pkg.detalles    ? `<div class="card-meta">📦 ${escapeHtml(pkg.detalles)}</div>` : "",
    ].join("");

    card.innerHTML = `
      <button class="card-delete" data-idx="${idx}" title="Eliminar">✕</button>
      <div class="card-tracking">${escapeHtml(pkg.tracking)}</div>
      <input class="card-label" type="text" value="${escapeHtml(pkg.label)}"
             data-idx="${idx}" placeholder="Sin nombre" />
      <div class="card-badge ${st.badgeClass}">${st.emoji} ${st.text}</div>
      <div class="card-raw-status">${escapeHtml(pkg.rawStatus)}</div>
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

  const saved = await loadStorage();

  const result = await fetchShipments();

  if (result.error === "not_logged_in") {
    document.getElementById("noticeLogin").style.display = "flex";
    packages = saved;
    document.getElementById("loadingState").style.display = "none";
    renderCards();
    return;
  }

  if (result.error) {
    showInfo(`No se pudo conectar con el sitio (${result.error}). Mostrando pedidos guardados.`);
    packages = saved;
    document.getElementById("loadingState").style.display = "none";
    renderCards();
    return;
  }

  const autoPackages = result.data || [];

  // Restaurar labels personalizados y agregar manuales que no estén en auto
  const labelMap = {};
  saved.forEach(p => { if (p.customLabel) labelMap[p.tracking] = p.customLabel; });

  autoPackages.forEach(p => {
    if (labelMap[p.tracking]) {
      p.label       = labelMap[p.tracking];
      p.customLabel = labelMap[p.tracking];
    }
  });

  const autoIds  = new Set(autoPackages.map(p => p.tracking));
  const manuals  = saved.filter(p => p.source === "manual" && !autoIds.has(p.tracking));

  packages = [...autoPackages, ...manuals];
  await saveStorage();

  document.getElementById("loadingState").style.display = "none";
  renderCards();
  setLastUpdated();
}

async function refreshAll() {
  const btn = document.getElementById("btnRefresh");
  btn.disabled = true;
  btn.textContent = "Actualizando...";
  await loadAndRender();
  btn.disabled = false;
  btn.textContent = "↻ Actualizar todos";
}

// ─── Eventos: grid (delegación) ───────────────────────────────────────────────
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

  packages.unshift({
    tracking,
    label:       label || tracking,
    customLabel: label || "",
    status:      "process",
    rawStatus:   "",
    source:      "manual",
  });

  await saveStorage();
  renderCards();
  document.getElementById("modalOverlay").style.display = "none";
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") document.getElementById("modalOverlay").style.display = "none";
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadAndRender();
