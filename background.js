// ─── Relay LIVE_DATA_READY from content script to open tracker tabs ───────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "LIVE_DATA_READY") {
    chrome.tabs.query({ url: chrome.runtime.getURL("index.html") }, (tabs) => {
      tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: "live-data-ready" }).catch(() => {}));
    });
  }

  if (msg.type === "FETCH_CORREO_DATA") {
    scrapeOpenTabs().then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
});

async function scrapeOpenTabs() {
  const tabs = await chrome.tabs.query({ url: "https://www.correoargentino.com.ar/MiCorreo/public/*" });
  const tabs2 = await chrome.tabs.query({ url: "https://correoargentino.com.ar/MiCorreo/public/*" });
  const allTabs = [...tabs, ...tabs2];
  if (!allTabs.length) return null;

  let pendientes = [], pagados = [];

  for (const tab of allTabs) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const url = window.location.href;
          const getCellText = (td) => {
            if (!td) return "";
            const div = td.querySelector("div");
            return (div ? div.textContent : td.textContent).trim();
          };

          if (url.includes("mis-envios")) {
            let rows = document.querySelectorAll("table.mcr-table tbody tr");
            if (!rows.length) rows = document.querySelectorAll("table tbody tr");
            const shipments = [];
            rows.forEach((row, idx) => {
              const tds = [...row.querySelectorAll("td")];
              if (tds.length < 5) return;
              const nOrden = getCellText(tds[3]);
              const origen = getCellText(tds[4]);
              const dest   = getCellText(tds[5]);
              const entrega = getCellText(tds[6]);
              const detalles = getCellText(tds[7]);
              const rawStatus = getCellText(tds[tds.length - 1]);
              const tracking = (nOrden && nOrden !== "-") ? nOrden
                : `envio-${origen}-${dest}-${idx}`.replace(/\s+/g, "_");
              shipments.push({ tracking, label: dest || `Envío ${idx+1}`,
                origen, destinatario: dest, entrega, detalles, rawStatus, source: "auto" });
            });
            return { type: "pendientes", data: shipments };
          }

          if (url.includes("listadooperaciones")) {
            const TRACKING_RE = /^[0-9A-Z]{8,}$/;
            let rows = document.querySelectorAll("table tbody tr");
            const shipments = [];
            rows.forEach((row, idx) => {
              const tds = [...row.querySelectorAll("td")];
              if (tds.length < 6) return;
              let tracking = "", trackingIdx = -1;
              for (let i = 0; i < tds.length; i++) {
                const clone = tds[i].cloneNode(true);
                clone.querySelectorAll("button,a,svg,i,input").forEach(el => el.remove());
                const txt = clone.textContent.trim().replace(/\s+/g, "");
                if (TRACKING_RE.test(txt)) { tracking = txt; trackingIdx = i; break; }
              }
              if (!tracking) return;
              const fecha = trackingIdx > 0 ? getCellText(tds[trackingIdx - 1]) : "";
              const origen = getCellText(tds[trackingIdx + 1]);
              const dest   = getCellText(tds[trackingIdx + 2]);
              const prov   = getCellText(tds[trackingIdx + 3]);
              const rawStatus = getCellText(tds[tds.length - 1]);
              shipments.push({ tracking, label: dest || `Envío ${idx+1}`,
                origen, destinatario: dest, entrega: prov,
                detalles: fecha ? `Fecha: ${fecha}` : "",
                rawStatus, lastDate: fecha, source: "pagado" });
            });
            return { type: "pagados", data: shipments };
          }

          return null;
        },
      });
      if (res?.result?.type === "pendientes") pendientes = res.result.data;
      if (res?.result?.type === "pagados")    pagados    = res.result.data;
    } catch {}
  }

  if (!pendientes.length && !pagados.length) return null;
  return { pendientes, pagados };
}

// Abrir tracker al clickear el ícono
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});

// Crear alarma de auto-refresh al instalar o iniciar
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("autoRefresh", { periodInMinutes: 15 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("autoRefresh", { periodInMinutes: 15 });
});

// Cuando suena la alarma, avisar a las pestañas del tracker abiertas
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "autoRefresh") return;
  chrome.tabs.query({ url: chrome.runtime.getURL("index.html") }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: "auto-refresh" }).catch(() => {});
    });
  });
});

// Actualizar badge cuando cambian los packages en storage
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.packages) return;
  const pkgs = changes.packages.newValue || [];
  const readyCount = pkgs.filter(p => p.status === "ready").length;
  chrome.action.setBadgeText({ text: readyCount > 0 ? String(readyCount) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#4caf50" });
});
