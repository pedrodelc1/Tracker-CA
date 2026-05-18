// Content script — runs inside MiCorreo pages at document_idle.
// Reads live DOM data after AJAX loads and saves to chrome.storage.
// The extension reads from storage instead of making cross-origin fetches.

(function () {
  const BASE = "https://www.correoargentino.com.ar/MiCorreo/public";

  function getCellText(td) {
    if (!td) return "";
    const div = td.querySelector("div");
    return (div ? div.textContent : td.textContent).trim();
  }

  // ── Parse mis-envios table ──────────────────────────────────────────────────
  function parseMisEnvios() {
    let rows = document.querySelectorAll("table.mcr-table tbody tr");
    if (!rows.length) rows = document.querySelectorAll(".dvEnvios table tbody tr");
    if (!rows.length) rows = document.querySelectorAll("table.table-hover tbody tr");
    if (!rows.length) rows = document.querySelectorAll("table tbody tr");
    if (!rows.length) return null;

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
      const tracking     = (nOrden && nOrden !== "-") ? nOrden
        : `envio-${origen}-${destinatario}-${idx}`.replace(/\s+/g, "_");
      shipments.push({ tracking, label: destinatario || `Envío ${idx + 1}`,
        origen, destinatario, entrega, detalles, rawStatus, source: "auto" });
    });
    return shipments.length ? shipments : null;
  }

  // ── Parse pagados table ─────────────────────────────────────────────────────
  function parsePagados(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    let rows = doc.querySelectorAll("#pendientes .panel-default table tbody tr");
    if (!rows.length) rows = doc.querySelectorAll("#pendientes table tbody tr");
    if (!rows.length) rows = doc.querySelectorAll("#myTabContent table tbody tr");
    if (!rows.length) rows = doc.querySelectorAll("table tbody tr");
    if (!rows.length) return [];

    const TRACKING_RE = /^[0-9A-Z]{10,}$/;
    const shipments = [];
    rows.forEach((row, idx) => {
      const tds = Array.from(row.querySelectorAll("td"));
      if (tds.length < 6) return;
      let tracking = "", trackingIdx = -1;
      for (let i = 0; i < tds.length; i++) {
        const clone = tds[i].cloneNode(true);
        clone.querySelectorAll("button,a,svg,i,span.sr-only").forEach(el => el.remove());
        const txt = clone.textContent.trim().replace(/\s+/g, "");
        if (TRACKING_RE.test(txt) && txt.length > 10) { tracking = txt; trackingIdx = i; break; }
      }
      if (!tracking) return;
      const fecha     = trackingIdx > 0 ? getCellText(tds[trackingIdx - 1]) : "";
      const origen    = getCellText(tds[trackingIdx + 1]);
      const dest      = getCellText(tds[trackingIdx + 2]);
      const provincia = getCellText(tds[trackingIdx + 3]);
      const rawStatus = getCellText(tds[tds.length - 1]);
      shipments.push({ tracking, label: dest || `Envío ${idx + 1}`,
        origen, destinatario: dest, entrega: provincia,
        detalles: fecha ? `Fecha: ${fecha}` : "", rawStatus, lastDate: fecha, source: "pagado" });
    });
    return shipments;
  }

  // ── Fetch pagados via POST (same-origin, works from content script) ─────────
  async function fetchPagados(token) {
    try {
      const body = new URLSearchParams({
        _token: token, fdesde: "", fhasta: "", tn: "",
        provincia_orig: "", provincia_dest: "",
        sucu_orig: "", sucu_dest: "", destino_nombre: "",
        pag: "0", sortc: "FECHA_CREACION", sortr: "1",
      }).toString();
      const r = await fetch(`${BASE}/qlistadoget_operaciones`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      console.log("[CorreoTracker] pagados status:", r.status, "url:", r.url);
      const html = await r.text();
      console.log("[CorreoTracker] pagados HTML (500 chars):", html.slice(0, 500));
      return r.ok ? html : null;
    } catch (e) {
      console.log("[CorreoTracker] pagados error:", e);
      return null;
    }
  }

  // ── Main: save data to storage when table is ready ──────────────────────────
  async function saveData() {
    const isMisEnvios = window.location.href.includes("mis-envios");
    const token = window.el_token || null;

    let pendientes = null;
    if (isMisEnvios) {
      pendientes = parseMisEnvios();
    }

    let pagados = [];
    if (token) {
      const html = await fetchPagados(token);
      if (html) pagados = parsePagados(html);
    }

    const hasData = (pendientes && pendientes.length > 0) || pagados.length > 0;
    if (!hasData) return false;

    chrome.storage.local.set({
      liveData: { pendientes: pendientes || [], pagados, ts: Date.now() },
    });
    chrome.runtime.sendMessage({ type: "LIVE_DATA_READY" }).catch(() => {});
    return true;
  }

  // Try immediately, then watch DOM for AJAX content
  saveData().then((ok) => {
    if (ok) return;
    const observer = new MutationObserver(() => {
      saveData().then((ok) => { if (ok) observer.disconnect(); });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  });
})();
