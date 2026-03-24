// Background service worker para la extension
// Maneja la comunicacion entre la web y el content script

const EXTENSION_STATE = {
  devices: [],
  lastUpdate: null,
  isConnected: false,
  dashboardTabId: null,
  backgroundMonitoring: false
};

// ─── Keep the service worker alive via open ports ───────────────────────────
// When the FMD content script connects with name 'keepAlivePort', we keep the
// SW alive and run our own fast refresh loop (service workers are not subject
// to the same timer throttling as background tab content scripts).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepAlivePort') return;

  console.log('[Background] keepAlivePort connected');

  // Run a periodic refresh driven by the service worker.
  // This is more reliable than setInterval inside the content script
  // because the content script's timers are throttled by Chrome when its
  // tab is in the background. Messages sent FROM the SW are delivered
  // immediately even to hidden-tab content scripts.
  // 15 seconds: short enough to feel responsive when the tab is in background,
  // long enough not to flood the content script with messages (which must DOM-parse
  // on each call). chrome.alarms minimum is 1 minute, so this SW-driven interval
  // is the highest-frequency refresh mechanism available for background tabs.
  const REFRESH_INTERVAL_MS = 15000; // 15 seconds
  let refreshTimer = setInterval(async () => {
    try {
      const allTabs = await chrome.tabs.query({});
      const findTab = allTabs.find(tab => isFindMyDeviceTab(tab.url));
      if (findTab && findTab.id) {
        chrome.tabs.sendMessage(findTab.id, { type: 'FORCE_REFRESH' }, () => {
          if (chrome.runtime.lastError) {} // Tab may not be ready yet — ignore
        });
      }
    } catch (e) {
      console.error('[Background] SW refresh error:', e);
    }
  }, REFRESH_INTERVAL_MS);

  port.onDisconnect.addListener(() => {
    console.log('[Background] keepAlivePort disconnected');
    clearInterval(refreshTimer);
    // When the content script reconnects it will open a new port
  });
});
// ────────────────────────────────────────────────────────────────────────────

// Escuchar mensajes del content script y del popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DEVICES_UPDATE') {
    EXTENSION_STATE.devices = message.devices;
    EXTENSION_STATE.lastUpdate = Date.now();
    
    // Notificar a las tabs del dashboard
    notifyDashboard(message);
    
    // Guardar en storage
    chrome.storage.local.set({
      devices: message.devices,
      lastUpdate: EXTENSION_STATE.lastUpdate
    });
    
    sendResponse({ status: 'received' });
  }
  
  if (message.type === 'DEVICES_CHANGED') {
    EXTENSION_STATE.devices = message.devices;
    notifyDashboard(message);
  }

  if (message.type === 'SET_BACKGROUND_MONITORING') {
    const enable = !!message.enable;
    EXTENSION_STATE.backgroundMonitoring = enable;
    chrome.storage.local.set({ backgroundMonitoring: enable });

    if (enable) {
      // Abrir pestaña de FMD en segundo plano si no hay ninguna abierta
      ensureFmdTabOpen();
    }

    sendResponse({ status: enable ? 'enabled' : 'disabled' });
    return true;
  }
  
  return true;
});

// Escuchar conexiones externas (desde la web)
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log('[Background] External message:', message, 'from:', sender.url);
  
  if (message.type === 'PING') {
    sendResponse({ 
      status: 'ok',
      version: chrome.runtime.getManifest().version
    });
    return true;
  }
  
  if (message.type === 'GET_DEVICES') {
    console.log('[Background] GET_DEVICES request', { from: sender.url });

    // Primero intentar obtener del storage (cache local)
    chrome.storage.local.get(['devices', 'lastUpdate'], (result) => {
      if (result.devices) {
        console.log('[Background] GET_DEVICES -> returning cached devices', {
          count: result.devices.length,
          lastUpdate: result.lastUpdate,
        });
        sendResponse({
          devices: result.devices,
          lastUpdate: result.lastUpdate,
          source: 'storage',
        });
      } else {
        // Intentar obtener del content script
        getDevicesFromContentScript()
          .then((devices) => {
            console.log('[Background] GET_DEVICES -> got devices from content script', {
              count: devices.length,
            });
            sendResponse({
              devices: devices,
              lastUpdate: Date.now(),
              source: 'live',
            });
          })
          .catch((err) => {
            console.error('[Background] GET_DEVICES -> failed to get devices', err);
            sendResponse({
              devices: [],
              error: err.message,
            });
          });
      }
    });
    return true;
  }
  
  if (message.type === 'START_MONITORING') {
    startMonitoringInFindMyDevice(message.interval);
    sendResponse({ status: 'started' });
    return true;
  }
  
  if (message.type === 'STOP_MONITORING') {
    stopMonitoringInFindMyDevice();
    sendResponse({ status: 'stopped' });
    return true;
  }
  
  if (message.type === 'OPEN_FIND_MY_DEVICE') {
    chrome.tabs.create({ 
      url: 'https://www.google.com/android/find',
      active: !message.background 
    });
    sendResponse({ status: 'opened' });
    return true;
  }
  
  return true;
});

// Abrir pestaña de FMD en segundo plano si no hay ninguna ya abierta
async function ensureFmdTabOpen() {
  try {
    const allTabs = await chrome.tabs.query({});
    const hasFmdTab = allTabs.some(tab => isFindMyDeviceTab(tab.url));
    if (!hasFmdTab) {
      console.log('[Background] Abriendo pestaña de FMD en segundo plano para monitoreo');
      chrome.tabs.create({
        url: 'https://www.google.com/android/find',
        active: false
      });
    }
  } catch (e) {
    console.error('[Background] ensureFmdTabOpen error:', e);
  }
}

// Delay (ms) to wait after a tab is removed before querying remaining tabs.
// Chrome removes the tab from the list asynchronously, so a brief pause
// ensures our query sees the correct post-removal state.
const TAB_REMOVAL_DEBOUNCE_MS = 500;

// Cuando se cierra una pestaña: si era la pestaña de FMD y el monitoreo en
// segundo plano está activo, reabrirla automáticamente de forma oculta.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!EXTENSION_STATE.backgroundMonitoring) return;
  // Pequeña espera para que la pestaña sea eliminada del listado antes de consultar
  setTimeout(() => {
    chrome.tabs.query({}, (allTabs) => {
      const hasFmdTab = allTabs.some(tab => isFindMyDeviceTab(tab.url));
      if (!hasFmdTab) {
        console.log('[Background] Pestaña FMD cerrada con monitoreo activo — reabriendo en segundo plano');
        chrome.tabs.create({
          url: 'https://www.google.com/android/find',
          active: false
        });
      }
    });
  }, TAB_REMOVAL_DEBOUNCE_MS);
});

// Al arrancar el navegador: restaurar el monitoreo en segundo plano si estaba activo
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['backgroundMonitoring'], (result) => {
    if (result.backgroundMonitoring) {
      console.log('[Background] Restaurando monitoreo en segundo plano tras inicio del navegador');
      EXTENSION_STATE.backgroundMonitoring = true;
      ensureFmdTabOpen();
    }
  });
});


function isFindMyDeviceTab(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const path = parsed.pathname;
    return (
      (host === 'www.google.com' && path.includes('/android/find')) ||
      host === 'findmydevice.google.com' ||
      (host === 'android.google.com' && path.startsWith('/find'))
    );
  } catch {
    return false;
  }
}

// Trigger a FORCE_REFRESH in the FMD tab immediately
async function forceRefreshFmdTab() {
  try {
    const allTabs = await chrome.tabs.query({});
    const findTab = allTabs.find(tab => isFindMyDeviceTab(tab.url));
    if (findTab && findTab.id) {
      chrome.tabs.sendMessage(findTab.id, { type: 'FORCE_REFRESH' }, () => {
        if (chrome.runtime.lastError) {} // Tab might not have content script yet
      });
    }
  } catch (e) {
    console.error('[Background] forceRefreshFmdTab error:', e);
  }
}

// When the user switches to the FMD tab, immediately pull fresh data
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (isFindMyDeviceTab(tab.url)) {
      console.log('[Background] FMD tab activated — requesting refresh');
      forceRefreshFmdTab();
    }
  } catch (e) {} // ignore
});

// When a FMD tab finishes loading, request fresh data
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isFindMyDeviceTab(tab.url)) {
    console.log('[Background] FMD tab loaded — scheduling initial refresh');
    // Give the content script a moment to initialize before sending the message
    setTimeout(() => forceRefreshFmdTab(), 5000);
  }
});

// Obtener dispositivos del content script
async function getDevicesFromContentScript() {
  // Consultar todas las pestañas y buscar Find My Device (URL antigua y nueva).
  const allTabs = await chrome.tabs.query({});
  const findTab = allTabs.find((tab) => isFindMyDeviceTab(tab.url));

  if (!findTab || !findTab.id) {
    throw new Error('Find My Device not open');
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(findTab.id, { type: 'GET_DEVICES' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.devices) {
        resolve(response.devices);
      } else {
        reject(new Error('No devices found'));
      }
    });
  });
}

// Iniciar monitoreo en Find My Device
async function startMonitoringInFindMyDevice(interval = 5000) {
  const allTabs = await chrome.tabs.query({});
  const findTab = allTabs.find((tab) => isFindMyDeviceTab(tab.url));

  if (!findTab || !findTab.id) {
    // Abrir Find My Device si no está abierto
    chrome.tabs.create({
      url: 'https://www.google.com/android/find',
      active: false,
    });
    return;
  }

  chrome.tabs.sendMessage(findTab.id, {
    type: 'START_MONITORING',
    interval: interval,
  });
}

// Detener monitoreo
async function stopMonitoringInFindMyDevice() {
  const allTabs = await chrome.tabs.query({});
  const findTabs = allTabs.filter((tab) => isFindMyDeviceTab(tab.url));

  findTabs.forEach((tab) => {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'STOP_MONITORING' });
    }
  });
}

// Notificar al dashboard
function notifyDashboard(data) {
  // Enviar a todas las tabs que escuchen (p.ej. localhost, 127.0.0.1, red local, vercel)
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (!tab.url) return;

      const isDevHost =
        tab.url.includes('localhost') ||
        tab.url.includes('127.0.0.1') ||
        tab.url.includes('192.168.') ||
        tab.url.includes('10.') ||
        tab.url.includes('vercel.app');

      if (isDevHost) {
        chrome.tabs.sendMessage(tab.id, data).catch(() => {});
      }
    });
  });
}

// Cuando se instala la extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Device Tracker] Extension installed');
  
  // Guardar estado inicial
  chrome.storage.local.set({
    devices: [],
    lastUpdate: null,
    backgroundMonitoring: false,
    settings: {
      autoMonitor: true,
      interval: 5000
    }
  });
});

// Alarm: keep the service worker alive and periodically refresh FMD data as a
// last-resort fallback (e.g. when the FMD tab is open but the keepAlivePort
// isn't connected).
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    console.log('[Background] Keep alive alarm — triggering FMD refresh');
    forceRefreshFmdTab();
  }
});

