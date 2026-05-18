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
  // Prefer a tab already on mis-envios so we can read live DOM
  let tabs = await chrome.tabs.query({
    url: "https://www.correoargentino.com.ar/MiCorreo/public/mis-envios*",
  });

  let tab, created = false;

  if (!tabs.length) {
    // Open a silent background tab and navigate to mis-envios
    tab = await chrome.tabs.create({
      url: "https://www.correoargentino.com.ar/MiCorreo/public/mis-envios",
      active: false,
    });
    created = true;
    await waitForTab(tab.id);
  } else {
    tab = tabs[0];
  }

  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const BASE = "https://www.correoargentino.com.ar/MiCorreo/public";

        // mis-envios data is loaded via AJAX — poll the live DOM until rows appear
        const waitForRows = () => new Promise((resolve) => {
          let attempts = 0;
          const tick = () => {
            const rows = document.querySelectorAll("table tbody tr");
            if (rows.length > 0 || attempts++ >= 20) {
              resolve(document.documentElement.outerHTML);
            } else {
              setTimeout(tick, 500);
            }
          };
          tick();
        });

        const isOnMisEnvios = window.location.href.includes("mis-envios");
        let misEnviosHtml;

        if (isOnMisEnvios) {
          misEnviosHtml = await waitForRows();
        } else {
          // Navigate the hidden tab to mis-envios and wait for data
          window.location.href = `${BASE}/mis-envios`;
          // This won't work in a synchronous way — fall back to fetch
          try {
            const r = await fetch(`${BASE}/mis-envios`, { credentials: "include" });
            misEnviosHtml = r.ok ? await r.text() : null;
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
    if (created) chrome.tabs.remove(tab.id).catch(() => {});
    return { error: "script_failed" };
  }

  if (created) chrome.tabs.remove(tab.id).catch(() => {});
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
