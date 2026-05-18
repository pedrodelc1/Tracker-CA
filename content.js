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


  // ── Parse pagados from live DOM (listadooperaciones page) ───────────────────
  function parsePagadosDom() {
    let rows = document.querySelectorAll("table tbody tr");
    if (!rows.length) return null;

    const TRACKING_RE = /^[0-9A-Z]{8,}$/;
    const shipments = [];

    rows.forEach((row, idx) => {
      const tds = Array.from(row.querySelectorAll("td"));
      if (tds.length < 6) return;

      // Find tracking number cell
      let tracking = "", trackingIdx = -1;
      for (let i = 0; i < tds.length; i++) {
        const clone = tds[i].cloneNode(true);
        clone.querySelectorAll("button,a,svg,i,span.sr-only,input").forEach(el => el.remove());
        const txt = clone.textContent.trim().replace(/\s+/g, "");
        if (TRACKING_RE.test(txt) && txt.length >= 8) { tracking = txt; trackingIdx = i; break; }
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
        rawStatus, lastDate: fecha, source: "pagado",
      });
    });
    return shipments.length ? shipments : null;
  }

  // ── Main: save data when table is ready ─────────────────────────────────────
  async function saveData() {
    const url = window.location.href;
    const isMisEnvios        = url.includes("mis-envios");
    const isListadoOps       = url.includes("listadooperaciones");
    console.log("[CorreoTracker] saveData — url:", url);

    // Load whatever is already saved so we can merge pages
    const existing = await new Promise(r =>
      chrome.storage.local.get(["liveData"], d => r(d.liveData || {}))
    );

    let pendientes = existing.pendientes || [];
    let pagados    = existing.pagados    || [];

    if (isMisEnvios) {
      const found = parseMisEnvios();
      console.log("[CorreoTracker] pendientes encontrados:", found ? found.length : 0);
      if (found) pendientes = found;
    }

    if (isListadoOps) {
      const found = parsePagadosDom();
      console.log("[CorreoTracker] pagados encontrados:", found ? found.length : 0);
      if (found) pagados = found;
    }

    chrome.storage.local.set({
      liveData: { pendientes, pagados, ts: Date.now() },
    });
    chrome.runtime.sendMessage({ type: "LIVE_DATA_READY" }).catch(() => {});
    return (pendientes.length + pagados.length) > 0;
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
