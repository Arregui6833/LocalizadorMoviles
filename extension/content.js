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

    // Eliminar duplicados por nombre/id
    const normalizeName = (name) => {
      if (!name) return "";
      return name
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/\s+/g, " ")
        .trim();
    };

    const isGeneratedId = (id) => {
      if (!id) return true;
      return /^(text|interactive|panel|marker)-/.test(id);
    };

    const map = new Map();

    devices.forEach((device) => {
      const nameKey = normalizeName(device.name);
      const idKey = !isGeneratedId(device.id) ? device.id : null;
      const key = idKey || nameKey;

      if (!key) return;

      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...device, name: device.name?.trim() });
        return;
      }

      // Merge data: prefer values where existing is missing
      const merged = { ...existing };
      Object.keys(device).forEach((field) => {
        if (!merged[field] && device[field] != null) {
          merged[field] = device[field];
        }
      });

      // Keep the best ID: prefer a real extension-provided id over generated ones
      if (isGeneratedId(existing.id) && !isGeneratedId(device.id)) {
        merged.id = device.id;
      }

      map.set(key, merged);
    });

    const uniqueDevices = Array.from(map.values());

    log('Dispositivos unicos encontrados:', uniqueDevices.length, uniqueDevices);
    return uniqueDevices;
  }

  // Estrategia 1: Analizar texto de la pagina buscando patrones de dispositivos
  function extractFromPageText() {
    const devices = [];

    // Buscar todos los elementos que podrian contener info de dispositivos
    // Google usa mucho divs con roles y clases dinamicas
    const allElements = document.querySelectorAll('div, span, button, a, p, li');

    const devicePatterns = [
      /pixel/i,
      /samsung/i,
      /galaxy/i,
      /iphone/i,
      /xiaomi/i,
      /redmi/i,
      /oneplus/i,
      /huawei/i,
      /oppo/i,
      /motorola/i,
      /nokia/i,
      /lg/i,
      /sony/i,
      /asus/i,
      /realme/i,
      /vivo/i,
      /poco/i,
      /tablet/i,
      /watch/i
    ];

    const batteryPattern = /(\d{1,3})\s*%/;
    const timePattern = /(hace\s+\d+\s+(?:minutos?|horas?|dias?)|\d{1,2}:\d{2}|last\s+seen|ultima\s+vez)/i;
    const statusPattern = /\b(en\s+linea|online|offline|desconectado|conectado|en\s+movimiento)\b/i;
    const locationPattern = /(?:ubicaci[oó]n|direcci[oó]n|location|address)[:\s]+(.+)/i;

    const foundNames = new Set();

    const normalize = (value) =>
      value
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();

    allElements.forEach((el) => {
      const text = el.textContent?.trim();
      if (!text || text.length > 200 || text.length < 2) return;

      const looksLikeDevice =
        devicePatterns.some((p) => p.test(text)) ||
        el.closest('[role="listitem"]') ||
        el.closest('[role="button"]');

      if (!looksLikeDevice) return;

      // Usar el texto como clave para evitar duplicados de nombres similares
      const key = normalize(text);
      if (foundNames.has(key)) return;
      foundNames.add(key);

      // Buscar en el contenedor principal del dispositivo (para evitar fragmentos sueltos)
      const container =
        el.closest('[role="listitem"]') ||
        el.closest('[role="option"]') ||
        el.closest('li') ||
        el.closest('div');
      const containerText = container?.textContent || text;

      const batteryMatch = containerText.match(batteryPattern);
      const timeMatch = containerText.match(timePattern);
      const statusMatch = containerText.match(statusPattern);
      const locationMatch = containerText.match(locationPattern);
      const coords = extractCoordinatesFromText(containerText);

      devices.push({
        id: `text-${devices.length}-${Date.now()}`,
        name: text,
        battery: batteryMatch ? parseInt(batteryMatch[1], 10) : null,
        lastSeen: timeMatch ? timeMatch[1] || timeMatch[0] : null,
        activity: statusMatch ? statusMatch[0] : null,
        location: locationMatch
          ? { address: locationMatch[1].trim(), lat: null, lng: null }
          : coords,
        isOnline: !!statusMatch && /en\s+linea|online|conectado/i.test(statusMatch[0]),
        source: 'text-scan',
        extractedAt: new Date().toISOString(),
      });
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
          activity: extractActivityFromElement(el),
          location: extractLocation(el),
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
            activity: extractActivityFromElement(panel),
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

  // Extraer actividad (activo ahora, en movimiento, ultimo visto, etc.)
  function extractActivityFromElement(el) {
    const text = el.textContent || '';

    const patterns = [
      /activo\s+ahora/i,
      /activo\s+hace\s+\d+\s+(?:minutos?|horas?|dias?)/i,
      /en\s+movimiento/i,
      /ultimo\s+visto[:\s]+(.+?)(?:\n|$)/i,
      /ultima\s+vez[:\s]+(.+?)(?:\n|$)/i,
      /last\s+seen[:\s]+(.+?)(?:\n|$)/i,
      /last\s+active[:\s]+(.+?)(?:\n|$)/i,
      /seen\s+\d+\s+\w+/i,
      /recientemente\s+activo/i,
      /hace\s+\d+\s+minutos?/i,
      /hace\s+\d+\s+horas?/i,
      /hace\s+\d+\s+d[ií]as?/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1] || match[0];
    }

    return null;
  }
  
  // Extraer ubicacion del panel de detalles
  function extractLocationFromPanel(panel) {
    // 1) Intentar extraer coordenadas del iframe de Google Maps
    const gmaps = document.querySelector('iframe[src*="maps"], .gm-style');
    if (gmaps) {
      const src = gmaps.getAttribute('src') || '';
      const coordMatch = src.match(/center=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
      if (coordMatch) {
        return {
          lat: parseFloat(coordMatch[1]),
          lng: parseFloat(coordMatch[2])
        };
      }
    }

    // 2) Buscar coordenadas en el texto del panel (ej. "40.1234, -3.1234")
    const panelText = panel.textContent || '';
    const coords = extractCoordinatesFromText(panelText);
    if (coords) {
      return coords;
    }

    // 3) Buscar elementos con datos de ubicación
    const addressEl = panel.querySelector('[data-address], .address, [data-ubicacion], .ubicacion');
    if (addressEl) {
      return { address: addressEl.textContent?.trim() };
    }

    // 4) Buscar texto que parezca dirección (ej. "Ubicación: ...")
    const addressMatch = panelText.match(/(?:ubicaci[oó]n|direcci[oó]n|location|address)[:\s]+(.+)/i);
    if (addressMatch) {
      const address = addressMatch[1].trim();
      // Si contiene coordenadas, extraerlas
      const coordsFromText = extractCoordinatesFromText(address);
      if (coordsFromText) return coordsFromText;
      return { address };
    }

    return null;
  }

  function extractCoordinatesFromText(text) {
    const coordMatch = text.match(/(-?\d{1,3}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/);
    if (coordMatch) {
      return {
        lat: parseFloat(coordMatch[1]),
        lng: parseFloat(coordMatch[2])
      };
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
    if (!parent) return null;

    // 1) Coordenadas en atributos data-*
    const lat = parent.getAttribute('data-lat') || parent.getAttribute('data-latitude');
    const lng = parent.getAttribute('data-lng') || parent.getAttribute('data-longitude');

    if (lat && lng) {
      return {
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        address: extractText(parent, '.address, [data-address]')
      };
    }

    // 2) Coordenadas en el texto
    const panelText = parent.textContent || '';
    const coords = extractCoordinatesFromText(panelText);
    if (coords) {
      return coords;
    }

    // 3) Texto estilo "Ubicación: ..." o "Address: ..."
    const locationText = extractText(parent, '.location, [data-location]');
    if (locationText) {
      return {
        address: locationText,
        lat: null,
        lng: null
      };
    }

    const addressMatch = panelText.match(/(?:ubicaci[oó]n|direcci[oó]n|location|address)[:\s]+(.+)/i);
    if (addressMatch) {
      return { address: addressMatch[1].trim() };
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
    // Solo aceptar mensajes del mismo contexto (misma página)
    if (event.source !== window || !event.data || typeof event.data !== 'object') return;
    const { type, requestId } = event.data;

    if (type === 'PING') {
      window.postMessage(
        {
          type: 'PONG',
          source: EXTENSION_ID,
          requestId,
          version: chrome.runtime.getManifest().version,
        },
        '*'
      );
      return;
    }

    if (type === 'REQUEST_DEVICES') {
      // Pedir al background script los dispositivos guardados (o extraerlos en Find My Device)
      chrome.runtime.sendMessage({ type: 'GET_DEVICES' }, (response) => {
        window.postMessage(
          {
            type: 'DEVICES_RESPONSE',
            source: EXTENSION_ID,
            requestId,
            devices: response?.devices || [],
            lastUpdate: response?.lastUpdate,
            error: response?.error,
          },
          '*'
        );
      });
      return;
    }

    if (type === 'START_MONITORING') {
      startMonitoring(event.data.interval || 5000);
      return;
    }

    if (type === 'STOP_MONITORING') {
      stopMonitoring();
      return;
    }

    if (type === 'OPEN_FIND_MY_DEVICE') {
      // Delegar al background para abrir la pestaña
      chrome.runtime.sendMessage({
        type: 'OPEN_FIND_MY_DEVICE',
        background: event.data.background,
      });
      return;
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
