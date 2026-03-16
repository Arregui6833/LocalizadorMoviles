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

    // Estrategia 4: Extraer de variables globales de la pagina
    const extractedFromGlobals = extractFromWindowGlobals();

    log('Desde texto:', extractedFromText.length);
    log('Desde elementos:', extractedFromInteractive.length);
    log('Desde red:', extractedFromNetwork.length);
    log('Desde globales:', extractedFromGlobals.length);

    // Combinar resultados
    devices.push(...extractedFromText);
    devices.push(...extractedFromInteractive);
    devices.push(...extractedFromNetwork);
    devices.push(...extractedFromGlobals);

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

    // Si hay marcadores de Google Maps y algún dispositivo no tiene ubicación, intentar asignar
    if (mapMarkers.length > 0) {
      let markerIdx = 0;
      uniqueDevices.forEach(device => {
        if (!device.location && markerIdx < mapMarkers.length) {
          device.location = {
            lat: mapMarkers[markerIdx].lat,
            lng: mapMarkers[markerIdx].lng,
            address: mapMarkers[markerIdx].title || null,
          };
          markerIdx++;
        }
      });
    }

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

      // Buscar en el contenedor principal del dispositivo.
      // Subir en el DOM hasta encontrar el contenedor más pequeño que incluya el porcentaje de batería.
      const container = findBestContainer(el);
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

  // Encontrar el mejor contenedor para un elemento de dispositivo.
  // Sube en el DOM para encontrar el ancestro más pequeño que contenga el nivel de batería.
  function findBestContainer(el) {
    // Primero intentar roles/elementos semánticos
    const named =
      el.closest('[role="listitem"]') ||
      el.closest('[role="option"]') ||
      el.closest('li');
    if (named) return named;

    // Subir en el DOM buscando el contenedor más pequeño que tenga un porcentaje
    let current = el.parentElement;
    let levels = 0;
    while (current && levels < 8) {
      const t = current.textContent || '';
      // Parar si el contenedor es demasiado grande (probablemente engloba múltiples dispositivos)
      if (t.length > 800) break;
      if (/\d{1,3}\s*%/.test(t)) return current;
      current = current.parentElement;
      levels++;
    }

    // Alternativa: subir hasta encontrar un contenedor de tamaño razonable
    current = el.parentElement;
    levels = 0;
    while (current && levels < 5) {
      if ((current.textContent || '').length < 500) return current;
      current = current.parentElement;
      levels++;
    }

    return el;
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

  // Comprobar si una URL debe ser interceptada para buscar datos de dispositivos
  function shouldInterceptUrl(url) {
    if (!url) return false;
    const u = url.toString();
    return (
      u.includes('android/find') ||
      u.includes('findmydevice.google.com') ||
      u.includes('devicemanagement') ||
      u.includes('googleapis.com/devicemanagement') ||
      u.includes('googleapis.com/android') ||
      u.includes('_/FindDevice') ||
      u.includes('android.google.com/find')
    );
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
      if (!shouldInterceptUrl(xhr._url)) return;
      try {
        // Eliminar prefijo anti-XSSI de Google (")]}'\n")
        let text = xhr.responseText;
        if (text && text.startsWith(')]}')) {
          text = text.substring(text.indexOf('\n') + 1);
        }
        const data = JSON.parse(text);
        processNetworkData(data);
      } catch (e) {
        // No es JSON válido
      }
    });
    
    return xhr;
  };

  // Interceptar Fetch
  const originalFetch = window.fetch;
  window.fetch = function(url, options) {
    return originalFetch.apply(this, arguments).then(response => {
      if (!shouldInterceptUrl(url)) return response;
      response.clone().text().then(text => {
        try {
          // Eliminar prefijo anti-XSSI de Google
          let t = text;
          if (t && t.startsWith(')]}')) {
            t = t.substring(t.indexOf('\n') + 1);
          }
          const data = JSON.parse(t);
          processNetworkData(data);
        } catch (e) {
          // No es JSON válido
        }
      }).catch(() => {});
      return response;
    });
  };

  // Procesar datos de red
  function processNetworkData(data) {
    if (!data) return;
    
    // Buscar estructura de dispositivos en la respuesta
    const devices = findDevicesInObject(data);
    if (devices.length > 0) {
      // Merge con datos existentes (preferir datos de red más completos)
      const existingNames = new Set(networkData.map(d => (d.name || '').toLowerCase()));
      devices.forEach(d => {
        if (d.name && !existingNames.has(d.name.toLowerCase())) {
          networkData.push(d);
        } else if (d.name) {
          // Actualizar el existente con datos nuevos
          const idx = networkData.findIndex(nd => nd.name?.toLowerCase() === d.name.toLowerCase());
          if (idx >= 0) {
            networkData[idx] = { ...networkData[idx], ...d };
          }
        }
      });
      notifyDashboard();
    }
  }

  // Extraer ubicación desde un objeto de coordenadas de cualquier formato conocido
  function extractLocationFromObj(obj) {
    if (!obj) return null;
    // Formato { lat, lng } o { lat, lon } o { latitude, longitude }
    const lat = obj.lat ?? obj.latitude ?? obj.Lat ?? obj.Latitude ?? null;
    const lng = obj.lng ?? obj.lon ?? obj.longitude ?? obj.Lng ?? obj.Longitude ?? null;
    if (lat != null && lng != null) {
      return {
        lat: typeof lat === 'number' ? lat : parseFloat(lat),
        lng: typeof lng === 'number' ? lng : parseFloat(lng),
        address: obj.address || obj.formattedAddress || obj.displayAddress || null,
      };
    }
    return null;
  }

  // Extraer nivel de batería desde un objeto de cualquier formato conocido
  function extractBatteryFromObj(obj) {
    if (obj == null) return null;
    if (typeof obj === 'number') return obj > 1 ? obj : Math.round(obj * 100);
    if (typeof obj === 'object') {
      const level = obj.level ?? obj.batteryLevel ?? obj.charge ?? obj.percentage ?? null;
      if (level != null) return typeof level === 'number' && level <= 1 ? Math.round(level * 100) : level;
    }
    return null;
  }

  // Buscar dispositivos en objeto recursivamente
  function findDevicesInObject(obj, depth = 0) {
    if (depth > 12) return [];
    const devices = [];
    
    if (Array.isArray(obj)) {
      obj.forEach(item => {
        devices.push(...findDevicesInObject(item, depth + 1));
      });
    } else if (obj && typeof obj === 'object') {
      // Detectar objeto que parece un dispositivo (múltiples nombres de campo posibles)
      const name =
        obj.name ||
        obj.deviceName ||
        obj.alias ||
        obj.friendlyName ||
        obj.displayName ||
        obj.deviceNickname ||
        obj.nickname ||
        obj.label ||
        null;

      if (name && typeof name === 'string' && name.length > 1 && name.length < 120) {
        // Construir objeto de ubicación
        const locObj =
          obj.location ||
          obj.lastKnownLocation ||
          obj.lastLocation ||
          obj.coordinates ||
          obj.geoLocation ||
          null;
        const location = extractLocationFromObj(locObj) ||
          (obj.lat != null && obj.lng != null
            ? { lat: parseFloat(obj.lat), lng: parseFloat(obj.lng), address: obj.address || null }
            : null) ||
          (obj.latitude != null && obj.longitude != null
            ? { lat: parseFloat(obj.latitude), lng: parseFloat(obj.longitude), address: null }
            : null);

        const batteryRaw =
          obj.battery ??
          obj.batteryLevel ??
          obj.batteryCharge ??
          obj.batteryPercentage ??
          obj.charge ??
          null;
        const battery = batteryRaw != null ? extractBatteryFromObj(batteryRaw) : null;

        const device = {
          id:
            obj.id ||
            obj.deviceId ||
            obj.imei ||
            obj.serialNumber ||
            obj.esn ||
            `net-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name,
          battery,
          lastSeen:
            obj.lastSeen ||
            obj.lastUpdate ||
            obj.lastOnline ||
            obj.timestamp ||
            obj.updatedAt ||
            null,
          activity: obj.activity || obj.status || null,
          location,
          isOnline: obj.online !== false && obj.isOnline !== false && obj.connected !== false,
          model: obj.model || obj.deviceModel || obj.hardware || null,
          source: 'network',
          extractedAt: new Date().toISOString(),
        };
        devices.push(device);
      }
      
      // Buscar en propiedades (evitar propiedades que son objetos de ubicación para no duplicar)
      const skipKeys = new Set(['location', 'lastKnownLocation', 'lastLocation', 'coordinates', 'geoLocation']);
      Object.entries(obj).forEach(([key, value]) => {
        if (!skipKeys.has(key) && value && typeof value === 'object') {
          devices.push(...findDevicesInObject(value, depth + 1));
        }
      });
    }
    
    return devices;
  }

  // Extraer datos de dispositivos desde variables globales de la página
  function extractFromWindowGlobals() {
    const devices = [];
    const candidates = [
      '__NUXT__',
      '__NEXT_DATA__',
      '__INITIAL_STATE__',
      '__APP_STATE__',
      '__data__',
      '__deviceData__',
      'deviceData',
      '__store__',
      'initialData',
    ];

    for (const key of candidates) {
      try {
        const val = window[key];
        if (val) {
          const found = findDevicesInObject(val);
          if (found.length > 0) {
            log('Dispositivos encontrados en window.' + key + ':', found.length);
            devices.push(...found);
          }
        }
      } catch (e) {
        // Ignorar errores de acceso
      }
    }

    return devices;
  }

  // Marcadores capturados del API de Google Maps
  const mapMarkers = [];

  // Enganchar el API de Google Maps para capturar posiciones de marcadores
  function hookGoogleMapsAPI() {
    let attempts = 0;
    function tryHook() {
      attempts++;
      const gm = window.google && window.google.maps;
      if (!gm) {
        if (attempts < 30) setTimeout(tryHook, 1000);
        return;
      }

      // Enganchar google.maps.Marker (API clásica)
      if (gm.Marker && !gm.Marker.__dtHooked) {
        const OrigMarker = gm.Marker;
        function HookedMarker(opts) {
          const inst = new OrigMarker(opts);
          if (opts && opts.position) {
            try {
              const pos = opts.position;
              const lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat;
              const lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;
              if (lat != null && lng != null) {
                mapMarkers.push({ lat, lng, title: opts.title || opts.label || null });
                log('Google Maps marker capturado:', lat, lng, opts.title);
              }
            } catch (e) { /* ignore */ }
          }
          return inst;
        }
        HookedMarker.prototype = OrigMarker.prototype;
        Object.setPrototypeOf(HookedMarker, OrigMarker);
        HookedMarker.__dtHooked = true;
        try { gm.Marker = HookedMarker; } catch (e) { /* ignore */ }
      }

      // Enganchar google.maps.marker.AdvancedMarkerElement (API nueva)
      const markerNS = gm.marker;
      if (markerNS && markerNS.AdvancedMarkerElement && !markerNS.AdvancedMarkerElement.__dtHooked) {
        const OrigAME = markerNS.AdvancedMarkerElement;
        class HookedAME extends OrigAME {
          constructor(opts) {
            super(opts);
            if (opts && opts.position) {
              try {
                const pos = opts.position;
                const lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat;
                const lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;
                if (lat != null && lng != null) {
                  mapMarkers.push({ lat, lng, title: opts.title || null });
                  log('AdvancedMarker capturado:', lat, lng, opts.title);
                }
              } catch (e) { /* ignore */ }
            }
          }
        }
        HookedAME.__dtHooked = true;
        try { markerNS.AdvancedMarkerElement = HookedAME; } catch (e) { /* ignore */ }
      }

      log('Google Maps API enganchada');
    }

    tryHook();
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

  // Enganchar el API de Google Maps lo antes posible
  hookGoogleMapsAPI();
  
  // Iniciar monitoreo automaticamente con delay mayor para esperar carga
  setTimeout(() => {
    log('Iniciando analisis inicial...');
    analyzeDOMStructure();
    startMonitoring(5000);
    notifyDashboard();
  }, 4000);

})();
