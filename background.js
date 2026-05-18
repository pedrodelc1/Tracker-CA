// ─── Fetch data via MiCorreo tab (avoids cross-origin block) ─────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FETCH_CORREO_DATA") {
    fetchViaTab().then(sendResponse).catch(() => sendResponse({ error: "failed" }));
    return true;
  }
});

async function waitForTab(tabId) {
  return new Promise((resolve) => {
    const check = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(check);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(check);
  });
}

async function fetchViaTab() {
  // Only use tabs the user already has open — never create new ones
  const tabs = await chrome.tabs.query({
    url: "https://www.correoargentino.com.ar/*",
  });

  if (!tabs.length) return { error: "not_logged_in" };

  // Prefer a tab already on mis-envios
  const tab = tabs.find(t => t.url.includes("mis-envios")) || tabs[0];

  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const BASE = "https://www.correoargentino.com.ar/MiCorreo/public";

        const isOnMisEnvios = window.location.href.includes("mis-envios");

        let misEnviosHtml;

        if (isOnMisEnvios) {
          // Page is already open — wait for AJAX to populate the table (up to 10s)
          await new Promise((resolve) => {
            let attempts = 0;
            const tick = () => {
              if (document.querySelectorAll("table tbody tr").length > 0 || attempts++ >= 20) {
                resolve();
              } else {
                setTimeout(tick, 500);
              }
            };
            tick();
          });
          misEnviosHtml = document.documentElement.outerHTML;
        } else {
          // Fetch mis-envios from this tab's same-origin context
          try {
            const r = await fetch(`${BASE}/mis-envios`, { credentials: "include" });
            misEnviosHtml = (r.ok && !r.url.includes("/login") && !r.url.includes("/error"))
              ? await r.text() : null;
          } catch { misEnviosHtml = null; }
        }

        if (!misEnviosHtml) return { error: "not_logged_in" };

        const token = window.el_token ||
          (misEnviosHtml.match(/var\s+el_token\s*=\s*["']([^"']+)["']/) || [])[1] || null;

        if (!token) return { misEnviosHtml, pagadosHtml: null };

        let pagadosHtml = null;
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
          if (r.ok && !r.url.includes("/error")) pagadosHtml = await r.text();
        } catch {}

        return { misEnviosHtml, pagadosHtml };
      },
    });
  } catch (e) {
    return { error: "script_failed" };
  }

  return result?.result || { error: "no_data" };
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
