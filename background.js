// ─── Fetch data via MiCorreo tab (avoids cross-origin block) ─────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FETCH_CORREO_DATA") {
    fetchViaTab().then(sendResponse).catch(() => sendResponse({ error: "failed" }));
    return true;
  }
});

async function fetchViaTab() {
  let tabs = await chrome.tabs.query({ url: "https://www.correoargentino.com.ar/*" });

  let tab, created = false;
  if (tabs.length) {
    tab = tabs[0];
  } else {
    // Open a background tab to make authenticated requests
    tab = await chrome.tabs.create({
      url: "https://www.correoargentino.com.ar/MiCorreo/public/mis-envios",
      active: false,
    });
    created = true;
    await new Promise((resolve) => {
      const onUpdated = (id, info) => {
        if (id === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  }

  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const BASE = "https://www.correoargentino.com.ar/MiCorreo/public";

        const getText = async (url, opts = {}) => {
          try {
            const r = await fetch(url, { credentials: "include", ...opts });
            if (!r.ok || r.url.includes("/error") || r.url.includes("/login")) return null;
            return await r.text();
          } catch { return null; }
        };

        const misEnviosHtml = await getText(`${BASE}/mis-envios`);
        if (!misEnviosHtml) return { error: "not_logged_in" };

        const token = window.el_token ||
          (misEnviosHtml.match(/var\s+el_token\s*=\s*["']([^"']+)["']/) || [])[1] || null;

        let pagadosHtml = null;
        if (token) {
          const body = new URLSearchParams({
            _token: token, fdesde: "", fhasta: "", tn: "",
            provincia_orig: "", provincia_dest: "",
            sucu_orig: "", sucu_dest: "", destino_nombre: "",
            pag: "0", sortc: "FECHA_CREACION", sortr: "1",
          }).toString();
          pagadosHtml = await getText(`${BASE}/qlistadoget_operaciones`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
          });
        }

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
