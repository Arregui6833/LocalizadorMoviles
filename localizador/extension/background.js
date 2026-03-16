// Background service worker para la extension
// Maneja la comunicacion entre la web y el content script

const EXTENSION_STATE = {
  devices: [],
  lastUpdate: null,
  isConnected: false,
  dashboardTabId: null
};

// Escuchar mensajes del content script
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
    // Primero intentar obtener del storage
    chrome.storage.local.get(['devices', 'lastUpdate'], (result) => {
      if (result.devices) {
        sendResponse({
          devices: result.devices,
          lastUpdate: result.lastUpdate,
          source: 'storage'
        });
      } else {
        // Intentar obtener del content script
        getDevicesFromContentScript().then(devices => {
          sendResponse({
            devices: devices,
            lastUpdate: Date.now(),
            source: 'live'
          });
        }).catch(err => {
          sendResponse({
            devices: [],
            error: err.message
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

// Obtener dispositivos del content script
async function getDevicesFromContentScript() {
  const tabs = await chrome.tabs.query({ url: 'https://www.google.com/android/find/*' });
  
  if (tabs.length === 0) {
    throw new Error('Find My Device not open');
  }
  
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_DEVICES' }, (response) => {
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
  const tabs = await chrome.tabs.query({ url: 'https://www.google.com/android/find/*' });
  
  if (tabs.length === 0) {
    // Abrir Find My Device si no esta abierto
    chrome.tabs.create({ 
      url: 'https://www.google.com/android/find',
      active: false 
    });
    return;
  }
  
  chrome.tabs.sendMessage(tabs[0].id, { 
    type: 'START_MONITORING',
    interval: interval 
  });
}

// Detener monitoreo
async function stopMonitoringInFindMyDevice() {
  const tabs = await chrome.tabs.query({ url: 'https://www.google.com/android/find/*' });
  
  tabs.forEach(tab => {
    chrome.tabs.sendMessage(tab.id, { type: 'STOP_MONITORING' });
  });
}

// Notificar al dashboard
function notifyDashboard(data) {
  // Enviar a todas las tabs que escuchen
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.url && (tab.url.includes('localhost') || tab.url.includes('vercel.app'))) {
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
    settings: {
      autoMonitor: true,
      interval: 5000
    }
  });
});

// Mantener el service worker activo
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    console.log('[Background] Keep alive ping');
  }
});
