// Content script que se inyecta en Google Find My Device
// Extrae informacion de los dispositivos del DOM

(function() {
  'use strict';

  const EXTENSION_ID = 'device-tracker-monitor';
  let lastDevices = [];
  let isMonitoring = false;
  let monitorInterval = null;

  // Debug mode
  const DEBUG = true;
  function log(...args) {
    if (DEBUG) console.log('[DeviceTracker]', ...args);
  }

  // Funcion principal para extraer dispositivos
  function extractDevices() {
    log('Extrayendo dispositivos...');
    const devices = [];
    
    // Estrategia 1: Buscar en todo el texto visible de la pagina
    const extractedFromText = extractFromPageText();
    
    // Estrategia 2: Buscar elementos interactivos (botones, links con nombres de dispositivos)
    const extractedFromInteractive = extractFromInteractiveElements();
    
    // Estrategia 3: Datos de red interceptados
    const extractedFromNetwork = getNetworkData();

    log('Desde texto:', extractedFromText.length);
    log('Desde elementos:', extractedFromInteractive.length);
    log('Desde red:', extractedFromNetwork.length);

    // Combinar resultados
    devices.push(...extractedFromText);
    devices.push(...extractedFromInteractive);
    devices.push(...extractedFromNetwork);

    // Eliminar duplicados por nombre
    const uniqueDevices = devices.reduce((acc, device) => {
      const existing = acc.find(d => d.name === device.name || d.id === device.id);
      if (!existing) {
        acc.push(device);
      } else {
        // Merge data - mantener el que tiene mas info
        Object.keys(device).forEach(key => {
          if (device[key] && !existing[key]) {
            existing[key] = device[key];
          }
        });
      }
      return acc;
    }, []);

    log('Dispositivos unicos encontrados:', uniqueDevices.length, uniqueDevices);
    return uniqueDevices;
  }

  // Estrategia 1: Analizar texto de la pagina buscando patrones de dispositivos
  function extractFromPageText() {
    const devices = [];
    
    // Buscar todos los elementos que podrian contener info de dispositivos
    // Google usa mucho divs con roles y clases dinamicas
    const allElements = document.querySelectorAll('div, span, button, a');
    
    const devicePatterns = [
      /pixel/i, /samsung/i, /galaxy/i, /iphone/i, /xiaomi/i, /redmi/i, 
      /oneplus/i, /huawei/i, /oppo/i, /motorola/i, /nokia/i, /lg/i,
      /sony/i, /asus/i, /realme/i, /vivo/i, /poco/i, /tablet/i, /watch/i
    ];
    
    const batteryPattern = /(\d{1,3})\s*%/;
    const timePattern = /hace\s+\d+\s+(minutos?|horas?|dias?)|(\d{1,2}:\d{2})|last seen|ultima vez/i;
    
    const foundNames = new Set();
    
    allElements.forEach(el => {
      const text = el.textContent?.trim();
      if (!text || text.length > 200 || text.length < 2) return;
      
      // Verificar si parece un nombre de dispositivo
      const looksLikeDevice = devicePatterns.some(p => p.test(text)) || 
        (el.closest('[role="listitem"]') || el.closest('[role="button"]'));
      
      if (looksLikeDevice && !foundNames.has(text)) {
        // Evitar textos muy largos o que son claramente no dispositivos
        if (text.length < 50 && !text.includes('\n')) {
          foundNames.add(text);
          
          // Buscar bateria cerca
          let battery = null;
          const parent = el.parentElement?.parentElement || el.parentElement;
          if (parent) {
            const parentText = parent.textContent;
            const batteryMatch = parentText?.match(batteryPattern);
            if (batteryMatch) {
              battery = parseInt(batteryMatch[1], 10);
            }
          }
          
          devices.push({
            id: `text-${devices.length}-${Date.now()}`,
            name: text,
            battery: battery,
            lastSeen: null,
            location: null,
            isOnline: true,
            source: 'text-scan',
            extractedAt: new Date().toISOString()
          });
        }
      }
    });
    
    return devices;
  }

  // Estrategia 2: Buscar elementos interactivos que representen dispositivos
  function extractFromInteractiveElements() {
    const devices = [];
    
    // Buscar en elementos con role="listitem" o role="button"
    const listItems = document.querySelectorAll('[role="listitem"], [role="option"], [data-deviceid], [data-id]');
    
    log('Elementos listitem/option encontrados:', listItems.length);
    
    listItems.forEach((el, index) => {
      const name = el.getAttribute('aria-label') || 
                   el.getAttribute('data-name') ||
                   el.querySelector('span, div')?.textContent?.trim();
      
      if (name && name.length > 1 && name.length < 100) {
        devices.push({
          id: el.getAttribute('data-deviceid') || el.getAttribute('data-id') || `interactive-${index}`,
          name: name.split('\n')[0].trim(), // Solo primera linea
          battery: extractBatteryFromElement(el),
          lastSeen: extractTimeFromElement(el),
          location: null,
          isOnline: !el.querySelector('[aria-label*="offline"]'),
          source: 'interactive',
          extractedAt: new Date().toISOString()
        });
      }
    });
    
    // Buscar en el panel de detalles (lado derecho normalmente)
    const detailPanels = document.querySelectorAll('[role="complementary"], [role="region"], aside, .detail-panel');
    detailPanels.forEach(panel => {
      const heading = panel.querySelector('h1, h2, h3, [role="heading"]');
      if (heading) {
        const name = heading.textContent?.trim();
        if (name && name.length > 1) {
          devices.push({
            id: `panel-${Date.now()}`,
            name: name,
            battery: extractBatteryFromElement(panel),
            lastSeen: extractTimeFromElement(panel),
            location: extractLocationFromPanel(panel),
            isOnline: true,
            source: 'detail-panel',
            extractedAt: new Date().toISOString()
          });
        }
      }
    });
    
    return devices;
  }

  // Extraer bateria de un elemento
  function extractBatteryFromElement(el) {
    const text = el.textContent || '';
    const match = text.match(/(\d{1,3})\s*%/);
    return match ? parseInt(match[1], 10) : null;
  }
  
  // Extraer tiempo de un elemento
  function extractTimeFromElement(el) {
    const text = el.textContent || '';
    const patterns = [
      /hace\s+(\d+\s+(?:minutos?|horas?|dias?))/i,
      /(\d{1,2}:\d{2}(?::\d{2})?)/,
      /last seen[:\s]+(.+?)(?:\n|$)/i,
      /ultima vez[:\s]+(.+?)(?:\n|$)/i
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1] || match[0];
    }
    return null;
  }
  
  // Extraer ubicacion del panel de detalles
  function extractLocationFromPanel(panel) {
    // Buscar coordenadas en el mapa o en atributos data-*
    const mapEl = document.querySelector('[data-lat][data-lng], .gm-style');
    
    // Intentar extraer de Google Maps embebido
    const gmaps = document.querySelector('iframe[src*="maps"], .gm-style');
    if (gmaps) {
      // Las coordenadas pueden estar en la URL del iframe
      const src = gmaps.getAttribute('src') || '';
      const coordMatch = src.match(/center=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
      if (coordMatch) {
        return {
          lat: parseFloat(coordMatch[1]),
          lng: parseFloat(coordMatch[2])
        };
      }
    }
    
    // Buscar direccion en texto
    const addressEl = panel.querySelector('[data-address], .address');
    if (addressEl) {
      return { address: addressEl.textContent?.trim() };
    }
    
    return null;
  }

  // Extraer texto de un elemento
  function extractText(parent, selector) {
    const el = parent.querySelector(selector);
    return el ? el.textContent.trim() : null;
  }

  // Extraer nivel de bateria
  function extractBattery(parent) {
    const batteryEl = parent.querySelector('[data-battery], .battery-level, .battery');
    if (batteryEl) {
      const text = batteryEl.textContent;
      const match = text.match(/(\d+)%?/);
      return match ? parseInt(match[1], 10) : null;
    }
    
    // Buscar en atributos
    const anyEl = parent.querySelector('[data-battery-level]');
    if (anyEl) {
      return parseInt(anyEl.getAttribute('data-battery-level'), 10);
    }
    
    return null;
  }

  // Extraer ubicacion
  function extractLocation(parent) {
    // Buscar coordenadas en atributos data-*
    const lat = parent.getAttribute('data-lat') || parent.getAttribute('data-latitude');
    const lng = parent.getAttribute('data-lng') || parent.getAttribute('data-longitude');
    
    if (lat && lng) {
      return {
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        address: extractText(parent, '.address, [data-address]')
      };
    }

    // Buscar en texto
    const locationText = extractText(parent, '.location, [data-location]');
    if (locationText) {
      return {
        address: locationText,
        lat: null,
        lng: null
      };
    }

    return null;
  }

  // Extraer dispositivo del panel lateral
  function extractDeviceFromPanel(panel) {
    const nameEl = panel.querySelector('h1, h2, .device-name');
    if (!nameEl) return null;

    return {
      id: panel.getAttribute('data-device-id') || 'panel-device',
      name: nameEl.textContent.trim(),
      battery: extractBattery(panel),
      lastSeen: extractText(panel, '.last-seen, [data-last-seen]'),
      location: extractLocation(panel),
      isOnline: true,
      extractedAt: new Date().toISOString()
    };
  }

  // Extraer datos del mapa (si hay marcadores)
  function extractFromMapData() {
    const devices = [];
    
    // Buscar marcadores en el mapa
    const markers = document.querySelectorAll('.marker, [data-marker], .gm-style img[src*="marker"]');
    
    markers.forEach((marker, index) => {
      const lat = marker.getAttribute('data-lat');
      const lng = marker.getAttribute('data-lng');
      
      if (lat && lng) {
        devices.push({
          id: `marker-${index}`,
          name: marker.getAttribute('title') || marker.getAttribute('aria-label') || `Marcador ${index + 1}`,
          location: {
            lat: parseFloat(lat),
            lng: parseFloat(lng)
          },
          extractedAt: new Date().toISOString()
        });
      }
    });

    return devices;
  }

  // Interceptar datos de red (XHR/Fetch)
  let networkData = [];

  function getNetworkData() {
    return networkData;
  }

  // Interceptar XHR
  const originalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new originalXHR();
    const originalOpen = xhr.open;
    
    xhr.open = function(method, url) {
      xhr._url = url;
      return originalOpen.apply(this, arguments);
    };
    
    xhr.addEventListener('load', function() {
      if (xhr._url && xhr._url.includes('android/find')) {
        try {
          const data = JSON.parse(xhr.responseText);
          processNetworkData(data);
        } catch (e) {
          // Not JSON
        }
      }
    });
    
    return xhr;
  };

  // Interceptar Fetch
  const originalFetch = window.fetch;
  window.fetch = function(url, options) {
    return originalFetch.apply(this, arguments).then(response => {
      if (url && url.toString().includes('android/find')) {
        response.clone().json().then(data => {
          processNetworkData(data);
        }).catch(() => {});
      }
      return response;
    });
  };

  // Procesar datos de red
  function processNetworkData(data) {
    if (!data) return;
    
    // Buscar estructura de dispositivos en la respuesta
    const devices = findDevicesInObject(data);
    if (devices.length > 0) {
      networkData = devices;
      notifyDashboard();
    }
  }

  // Buscar dispositivos en objeto recursivamente
  function findDevicesInObject(obj, depth = 0) {
    if (depth > 10) return [];
    const devices = [];
    
    if (Array.isArray(obj)) {
      obj.forEach(item => {
        devices.push(...findDevicesInObject(item, depth + 1));
      });
    } else if (obj && typeof obj === 'object') {
      // Verificar si es un dispositivo
      if (obj.name || obj.deviceName || obj.alias) {
        const device = {
          id: obj.id || obj.deviceId || obj.imei || `net-${Date.now()}`,
          name: obj.name || obj.deviceName || obj.alias,
          battery: obj.battery || obj.batteryLevel,
          lastSeen: obj.lastSeen || obj.lastUpdate || obj.timestamp,
          location: obj.location || (obj.lat && obj.lng ? { lat: obj.lat, lng: obj.lng } : null),
          isOnline: obj.online !== false,
          model: obj.model || obj.deviceModel,
          extractedAt: new Date().toISOString()
        };
        devices.push(device);
      }
      
      // Buscar en propiedades
      Object.values(obj).forEach(value => {
        devices.push(...findDevicesInObject(value, depth + 1));
      });
    }
    
    return devices;
  }

  // Notificar al dashboard
  function notifyDashboard() {
    const devices = extractDevices();
    
    // Guardar en storage
    chrome.storage.local.set({ devices, lastUpdate: Date.now() });
    
    // Enviar al background script
    chrome.runtime.sendMessage({
      type: 'DEVICES_UPDATE',
      devices: devices
    });
  }

  // Escuchar mensajes del dashboard web
  window.addEventListener('message', (event) => {
    // Verificar origen
    if (event.data && event.data.type === 'REQUEST_DEVICES') {
      const devices = extractDevices();
      
      window.postMessage({
        type: 'DEVICES_RESPONSE',
        source: EXTENSION_ID,
        devices: devices
      }, '*');
    }
    
    if (event.data && event.data.type === 'START_MONITORING') {
      startMonitoring(event.data.interval || 5000);
    }
    
    if (event.data && event.data.type === 'STOP_MONITORING') {
      stopMonitoring();
    }
  });

  // Escuchar mensajes del background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_DEVICES') {
      const devices = extractDevices();
      sendResponse({ devices });
    }
    
    if (message.type === 'START_MONITORING') {
      startMonitoring(message.interval || 5000);
      sendResponse({ status: 'started' });
    }
    
    if (message.type === 'STOP_MONITORING') {
      stopMonitoring();
      sendResponse({ status: 'stopped' });
    }
    
    return true;
  });

  // Iniciar monitoreo continuo
  function startMonitoring(interval = 5000) {
    if (isMonitoring) return;
    
    isMonitoring = true;
    monitorInterval = setInterval(() => {
      const devices = extractDevices();
      
      // Detectar cambios
      const hasChanges = JSON.stringify(devices) !== JSON.stringify(lastDevices);
      
      if (hasChanges) {
        lastDevices = devices;
        notifyDashboard();
        
        // Notificar cambios
        chrome.runtime.sendMessage({
          type: 'DEVICES_CHANGED',
          devices: devices,
          timestamp: Date.now()
        });
      }
    }, interval);
  }

  // Detener monitoreo
  function stopMonitoring() {
    isMonitoring = false;
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
  }

  // Observador de mutaciones para detectar cambios en el DOM
  const observer = new MutationObserver((mutations) => {
    if (isMonitoring) {
      // Debounce
      clearTimeout(observer._timeout);
      observer._timeout = setTimeout(() => {
        notifyDashboard();
      }, 500);
    }
  });

  // Iniciar observador cuando la pagina cargue
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-device-id', 'data-lat', 'data-lng', 'data-battery']
  });

  // Funcion para analizar y volcar la estructura del DOM (debug)
  function analyzeDOMStructure() {
    log('=== ANALIZANDO ESTRUCTURA DEL DOM ===');
    
    // 1. Buscar elementos con data attributes
    const dataElements = document.querySelectorAll('[data-deviceid], [data-device], [data-id], [data-item]');
    log('Elementos con data-*:', dataElements.length);
    dataElements.forEach(el => {
      log('  - ', el.tagName, Array.from(el.attributes).map(a => `${a.name}="${a.value}"`).join(' '));
    });
    
    // 2. Buscar listas
    const lists = document.querySelectorAll('[role="list"], [role="listbox"], ul, ol');
    log('Listas encontradas:', lists.length);
    lists.forEach((list, i) => {
      const items = list.querySelectorAll('[role="listitem"], [role="option"], li');
      log(`  Lista ${i}:`, items.length, 'items');
      items.forEach((item, j) => {
        if (j < 5) { // Solo primeros 5
          log(`    Item ${j}:`, item.textContent?.substring(0, 100));
        }
      });
    });
    
    // 3. Buscar headings que podrian ser nombres de dispositivos
    const headings = document.querySelectorAll('h1, h2, h3, [role="heading"]');
    log('Headings:', headings.length);
    headings.forEach(h => {
      log('  -', h.tagName, h.textContent?.substring(0, 50));
    });
    
    // 4. Buscar elementos con porcentaje (bateria)
    const batteryTexts = [];
    document.body.querySelectorAll('*').forEach(el => {
      if (el.children.length === 0) { // Solo nodos hoja
        const text = el.textContent?.trim();
        if (text && /\d{1,3}%/.test(text) && text.length < 20) {
          batteryTexts.push({ text, tag: el.tagName, parent: el.parentElement?.className });
        }
      }
    });
    log('Textos con porcentaje:', batteryTexts);
    
    // 5. Buscar el mapa
    const maps = document.querySelectorAll('.gm-style, [data-map], #map, canvas');
    log('Elementos de mapa:', maps.length);
    
    // 6. Analizar estructura principal
    const main = document.querySelector('main, [role="main"], #main');
    if (main) {
      log('Main element encontrado');
      const children = main.children;
      log('Hijos directos de main:', children.length);
      Array.from(children).forEach((child, i) => {
        log(`  ${i}: ${child.tagName}.${child.className?.split(' ')[0] || ''} - ${child.getAttribute('role') || ''}`);
      });
    }
    
    // 7. Buscar cualquier cosa que parezca un dispositivo Android
    const allText = document.body.innerText;
    const deviceMentions = allText.match(/(pixel|samsung|galaxy|android|phone|telefono|movil|dispositivo).{0,50}/gi);
    log('Menciones de dispositivos:', deviceMentions?.slice(0, 10));
    
    return {
      dataElements: dataElements.length,
      lists: lists.length,
      headings: headings.length,
      batteryTexts,
      maps: maps.length,
      deviceMentions: deviceMentions?.length || 0
    };
  }
  
  // Agregar listener para solicitar analisis de DOM
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ANALYZE_DOM') {
      const analysis = analyzeDOMStructure();
      sendResponse({ analysis });
    }
    return true;
  });

  // Notificar que la extension esta lista
  console.log('[Device Tracker] Extension loaded on Find My Device');
  log('Ejecuta analyzeDOMStructure() en la consola para ver la estructura del DOM');
  
  // Exponer funcion globalmente para debug
  window.__deviceTrackerAnalyze = analyzeDOMStructure;
  
  // Iniciar monitoreo automaticamente con delay mayor para esperar carga
  setTimeout(() => {
    log('Iniciando analisis inicial...');
    analyzeDOMStructure();
    startMonitoring(5000);
    notifyDashboard();
  }, 4000);

})();
