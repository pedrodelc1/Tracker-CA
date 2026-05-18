// ─── Relay LIVE_DATA_READY from content script to open tracker tabs ───────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "LIVE_DATA_READY") return;
  chrome.tabs.query({ url: chrome.runtime.getURL("index.html") }, (tabs) => {
    tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: "live-data-ready" }).catch(() => {}));
  });
});

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
