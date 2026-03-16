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
  async function extractDevices() {
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
      // Create a more unique key using name, battery, and lastSeen
      const nameKey = normalizeName(device.name);
      const batteryKey = device.battery || 'no-battery';
      const lastSeenKey = device.lastSeen || 'no-lastseen';
      const key = `${nameKey}|${batteryKey}|${lastSeenKey}`;

      if (!nameKey) return;

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

    // Filter out devices with no useful info (likely false positives)
    const filteredDevices = uniqueDevices.filter(device => 
      device.name && device.name.length > 1 && device.name.length < 100
    );

    // Si hay marcadores de Google Maps y algún dispositivo no tiene ubicación, intentar asignar
    if (mapMarkers.length > 0) {
      let markerIdx = 0;
      filteredDevices.forEach(device => {
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

    // Si aún no hay ubicación, buscar coordenadas globales en la página
    const pageText = document.body.innerText;
    const globalCoords = extractCoordinatesFromText(pageText);
    if (globalCoords) {
      filteredDevices.forEach(device => {
        if (!device.location) {
          device.location = globalCoords;
        }
      });
    }

    // Intentar hacer clic en dispositivos para extraer ubicaciones
    // Esto se hace de forma segura y con manejo de errores
    if (filteredDevices.length > 0) {
      simulateUserClicks(filteredDevices);
    }

    log('Dispositivos finales:', filteredDevices.length, filteredDevices);
    return filteredDevices;
  }

  // Función para simular clics en dispositivos de forma segura
  async function simulateUserClicks(devices) {
    if (!devices || devices.length === 0) return;
    
    log('Iniciando simulación de clics en', devices.length, 'dispositivos');
    
    // Paso 1: Buscar todos los contenedores de dispositivos
    const deviceContainers = findAllDeviceContainers();
    log('Contenedores de dispositivos encontrados:', deviceContainers.length);
    
    if (deviceContainers.length === 0) {
      log('No se encontraron contenedores de dispositivos');
      return;
    }
    
    // Paso 2: Mapear dispositivos a contenedores
    const mappedDevices = [];
    devices.forEach(device => {
      const deviceName = device.name?.trim().toLowerCase() || '';
      
      // Buscar el contenedor que contiene este nombre
      const container = deviceContainers.find(cont => {
        const containerText = cont.textContent?.toLowerCase() || '';
        return containerText.includes(deviceName);
      });
      
      if (container) {
        mappedDevices.push({
          device,
          container
        });
        log('Dispositivo mapeado:', device.name);
      }
    });
    
    log('Dispositivos mapeados:', mappedDevices.length, '/', devices.length);
    
    if (mappedDevices.length === 0) {
      log('No se pudieron mapear dispositivos a contenedores');
      return;
    }
    
    // Paso 3: Hacer clic en cada dispositivo secuencialmente
    for (let i = 0; i < mappedDevices.length; i++) {
      const { device, container } = mappedDevices[i];
      
      try {
        log('=== DISPOSITIVO', i + 1, '/', mappedDevices.length, ':', device.name, '===');
        
        // PASO A: Hacer clic en el dispositivo para entrar en vista detallada
        log('PASO A: Haciendo clic en dispositivo para ver detalles');
        let clickableElement = findClickableElementInList(container);
        
        if (!clickableElement) {
          log('❌ No se encontró elemento clickeable para', device.name);
          continue;
        }
        
        // Scroll a la vista si es necesario
        clickableElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Simular evento de click con todos los parámetros necesarios
        const clickEvent = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          buttons: 1,
          clientX: clickableElement.getBoundingClientRect().left + 10,
          clientY: clickableElement.getBoundingClientRect().top + 10
        });
        
        clickableElement.dispatchEvent(clickEvent);
        
        if (typeof clickableElement.click === 'function') {
          await new Promise(resolve => setTimeout(resolve, 100));
          clickableElement.click();
        }
        
        log('✓ Click enviado, esperando carga de detalles...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // PASO B: Esperar a que se capture la ubicación
        log('PASO B: Esperando captura de ubicación desde API');
        let locationCaptured = false;
        let captureWaitTime = 0;
        const MAX_WAIT = 5000; // máximo 5 segundos
        
        while (!locationCaptured && captureWaitTime < MAX_WAIT) {
          const currentDeviceData = lastDevices.find(d => 
            d.name?.toLowerCase() === device.name?.toLowerCase()
          );
          
          if (currentDeviceData && currentDeviceData.location && 
              currentDeviceData.location.lat && currentDeviceData.location.lng) {
            log('✓ Ubicación capturada:', currentDeviceData.location);
            locationCaptured = true;
            break;
          }
          
          await new Promise(resolve => setTimeout(resolve, 500));
          captureWaitTime += 500;
        }
        
        if (!locationCaptured) {
          log('⚠ Ubicación no capturada después de', MAX_WAIT, 'ms');
        } else {
          log('✓ Ubicación confirmada para', device.name);
        }
        
        // PASO C: Hacer clic en botón "Back" para volver a la lista
        log('PASO C: Haciendo clic en botón Back para volver a la lista');
        const backButton = findBackButton();
        
        if (backButton) {
          log('✓ Botón Back encontrado, clickeando...');
          backButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await new Promise(resolve => setTimeout(resolve, 200));
          
          const backClickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            buttons: 1,
            clientX: backButton.getBoundingClientRect().left + 10,
            clientY: backButton.getBoundingClientRect().top + 10
          });
          
          backButton.dispatchEvent(backClickEvent);
          
          if (typeof backButton.click === 'function') {
            await new Promise(resolve => setTimeout(resolve, 100));
            backButton.click();
          }
          
          log('✓ Click en Back enviado, esperando vuelta a lista...');
          await new Promise(resolve => setTimeout(resolve, 1500));
        } else {
          log('❌ Botón Back no encontrado');
        }
        
        log('✓ Dispositivo completado:', device.name);
        log('');
        
      } catch (e) {
        log('❌ Error al procesar dispositivo', device.name, ':', e.message);
      }
    }
    
    log('=== Completados todos los clics en dispositivos ===');
  }

  // Encontrar el botón "Back" en la vista detallada
  function findBackButton() {
    // El botón Back tiene aria-label="Back"
    const backButton = document.querySelector('button[aria-label="Back"]');
    if (backButton) {
      log('Botón Back encontrado con aria-label');
      return backButton;
    }
    
    // Fallback: buscar por clase y contenido
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const hasArrow = btn.querySelector('[aria-hidden="true"] i.google-material-icons:contains("arrow_back")');
      if (hasArrow || btn.innerText?.toLowerCase().includes('back')) {
        log('Botón Back encontrado por icono/texto');
        return btn;
      }
    }
    
    // Fallback: buscar por posición (primer botón en esquina superior izquierda)
    const topLeftButton = document.querySelector('.VYBDae-Bz112c-LgbsSe');
    if (topLeftButton && topLeftButton.getAttribute('aria-label')?.toLowerCase().includes('back')) {
      log('Botón Back encontrado por posición');
      return topLeftButton;
    }
    
    return null;
  }

  // Encontrar todos los contenedores de dispositivos en la VISTA DE LISTA
  function findAllDeviceContainers() {
    const containers = [];
    const seen = new Set();
    
    // En la VISTA DE LISTA, los dispositivos están en estructuras como:
    // <div class="NVStyd">
    //   <div><img/></div>
    //   <div>Nombre</div>
    //   ...
    // </div>
    
    // La estrategia PRINCIPAL es buscar div.NVStyd (es el estándar de Google)
    const nvstydDivs = document.querySelectorAll('div.NVStyd');
    if (nvstydDivs.length > 0) {
      log('Encontrados', nvstydDivs.length, 'contenedores div.NVStyd');
      nvstydDivs.forEach(el => {
        if (!seen.has(el) && el.textContent?.length > 5) {
          containers.push(el);
          seen.add(el);
        }
      });
      return containers; // Si encontramos NVStyd, usamos solo esos (son los correctos)
    }
    
    // FALLBACK si no hay NVStyd: buscar otras estructuras de dispositivos
    const addContainer = (el) => {
      if (!el || seen.has(el)) return;
      if (el.textContent && el.textContent.length > 5) {
        containers.push(el);
        seen.add(el);
      }
    };
    
    // Buscar elementos con role="listitem" o "option"
    document.querySelectorAll('[role="listitem"], [role="option"]').forEach(el => addContainer(el));
    
    // Buscar divs dentro de listas
    document.querySelectorAll('[role="list"] > div, [role="listbox"] > div').forEach(el => addContainer(el));
    
    // Buscar divs con clases que sugieran ser items de lista
    document.querySelectorAll('div[class*="item"], div[class*="device"], div[class*="card"], div[class*="row"]').forEach(el => {
      if (el.textContent?.length > 5) addContainer(el);
    });
    
    log('Total de contenedores encontrados:', containers.length);
    return containers;
  }

  // Encontrar el elemento clickeable en la VISTA DE LISTA (div.NVStyd)
  function findClickableElementInList(container) {
    // En la LISTA, el contenedor es div.NVStyd
    // Estructura:
    // <div class="NVStyd">
    //   <div><img/></div>          ← Clickear aqui (imagen)
    //   <div>Nombre</div>
    //   <div>Status</div>
    //   ...
    // </div>
    
    log('Buscando elemento clickeable en lista...');
    
    // 1. Buscar la img directamente (es lo más seguro)
    let clickable = container.querySelector('img');
    if (clickable) {
      log('✓ Encontrado img en lista');
      return clickable;
    }
    
    // 2. Buscar el primer div que tenga la img
    clickable = container.querySelector('div:has(img)');
    if (clickable) {
      log('✓ Encontrado div:has(img) en lista');
      return clickable;
    }
    
    // 3. Clickear el container NVStyd directamente
    if (container.classList.contains('NVStyd')) {
      log('✓ Usando contenedor NVStyd directamente');
      return container;
    }
    
    // 4. Si nada, NO devolver nada
    log('❌ No se encontró elemento clickeable en lista');
    return null;
  }

  // Encontrar el elemento clickeable dentro de un contenedor (que sea el dispositivo, no las acciones)
  function findClickableElement(container) {
    // ESTRATEGIA SIMPLE Y DIRECTA:
    // En la vista detallada, clickear SOLO el área de imagen+nombre
    // NO los botones de acción (Reproducir, Marcar perdido, etc.)
    
    // Estructura esperada:
    // <div class="Z3br3c">
    //   <div class="rA4wRb"><img.../></div>     ← CLICKEAR AQUI
    //   <div class="aYfhoe">                    ← O AQUI
    //     <div>Nombre</div>
    //   </div>
    // </div>
    // <div class="fas8Ad">                     ← NO AQUI
    //   Botones de acción
    // </div>
    
    log('Buscando elemento clickeable en detalles...');
    
    // 1. Buscar div.rA4wRb (la imagen) - es el más específico
    let clickable = container.querySelector('div.rA4wRb');
    if (clickable) {
      log('✓ Encontrado div.rA4wRb en detalles');
      return clickable;
    }
    
    // 2. Buscar div.aYfhoe (área de info) - segundo más específico
    clickable = container.querySelector('div.aYfhoe');
    if (clickable) {
      log('✓ Encontrado div.aYfhoe en detalles');
      return clickable;
    }
    
    // 3. Buscar div.Z3br3c (contenedor principal)
    clickable = container.querySelector('div.Z3br3c');
    if (clickable) {
      log('✓ Encontrado div.Z3br3c en detalles');
      return clickable;
    }
    
    // 4. Buscar img (foto del dispositivo)
    clickable = container.querySelector('img');
    if (clickable) {
      log('✓ Encontrado img en detalles');
      return clickable;
    }
    
    // Si nada funciona, NO devolver nada (mejor no hacer clic que hacer clic mal)
    log('❌ No se encontró elemento clickeable seguro en detalles');
    return null;
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

      // Skip if text matches multiple device patterns (likely concatenated names)
      const patternMatches = devicePatterns.filter(p => p.test(text)).length;
      if (patternMatches > 1) return;

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
    // Si panel es document, buscar globalmente
    const searchRoot = panel === document ? document : panel;
    
    // 1) Intentar extraer coordenadas del iframe de Google Maps
    const gmaps = searchRoot.querySelector('iframe[src*="maps"], .gm-style');
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
    const panelText = searchRoot.textContent || '';
    const coords = extractCoordinatesFromText(panelText);
    if (coords) {
      return coords;
    }

    // 3) Buscar elementos con datos de ubicación
    const addressEl = searchRoot.querySelector('[data-address], .address, [data-ubicacion], .ubicacion');
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

  // Extraer ubicación haciendo clic en cada dispositivo
  async function extractLocationsByClicking(devices) {
    log('Iniciando extracción de ubicaciones por clic');
    
    // Usar los mismos selectores que la extracción interactiva
    const allElements = document.querySelectorAll('[role="listitem"], [role="option"], [data-deviceid], [data-id]');
    
    log('Elementos encontrados con selectores de lista:', allElements.length);
    
    // Filtrar elementos que contengan texto que parezca nombre de dispositivo
    const deviceElements = [];
    
    allElements.forEach(el => {
      const text = el.textContent?.trim() || '';
      if (text.length < 2 || text.length > 100) return;
      
      const devicePatterns = [
        /pixel/i, /samsung/i, /galaxy/i, /iphone/i, /xiaomi/i, /redmi/i, /oneplus/i, /huawei/i, /oppo/i, /motorola/i, /nokia/i, /lg/i, /sony/i, /asus/i, /realme/i, /vivo/i, /poco/i, /tablet/i, /watch/i, /honor/i, /nothing/i, /jbl/i, /wh-1000xm/i
      ];
      
      const matchesPattern = devicePatterns.some(p => p.test(text));
      if (matchesPattern) {
        // Buscar un botón hijo para hacer clic (ej. "Find", "Locate")
        const locateButton = el.querySelector('button, [role="button"], a');
        if (locateButton) {
          const buttonText = locateButton.textContent?.trim() || '';
          if (buttonText.match(/find|locate|buscar|ubicación|localizar/i) || buttonText === '') {
            deviceElements.push(locateButton);
            log('Botón de localización encontrado para:', text.substring(0, 30));
          }
        } else {
          // Si no hay botón específico, usar el elemento principal si es clickeable
          deviceElements.push(el);
          log('Elemento clickeable encontrado:', text.substring(0, 30));
        }
      }
    });
    
    log('Elementos clickeables encontrados:', deviceElements.length);
    
    if (deviceElements.length === 0) {
      log('No se encontraron elementos clickeables que parezcan dispositivos');
      return;
    }

    log('Intentando extraer ubicaciones haciendo clic en', Math.min(deviceElements.length, devices.length), 'elementos');

    for (let i = 0; i < deviceElements.length && i < devices.length; i++) {
      const el = deviceElements[i];
      const device = devices[i];

      if (device.location) {
        log('Dispositivo', device.name, 'ya tiene ubicación, saltando');
        continue;
      }

      try {
        const text = el.textContent?.substring(0, 50) || 'sin texto';
        log('Haciendo clic en elemento', i, text);
        
        // Hacer clic en el elemento
        el.click();
        
        // Esperar a que cargue la ubicación
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Buscar el panel de detalles
        const detailPanel = document.querySelector('[role="complementary"], [role="region"], aside, .detail-panel, #device-details, .device-details');
        
        if (detailPanel) {
          log('Panel de detalles encontrado, extrayendo ubicación');
          const location = extractLocationFromPanel(detailPanel);
          if (location) {
            device.location = location;
            log('Ubicación extraída para', device.name, location);
          } else {
            log('No se pudo extraer ubicación del panel');
          }
        } else {
          log('No se encontró panel de detalles después del clic');
          // Intentar extraer de todo el documento como fallback
          const location = extractLocationFromPanel(document);
          if (location) {
            device.location = location;
            log('Ubicación extraída del documento para', device.name, location);
          }
        }
      } catch (e) {
        log('Error al hacer clic en dispositivo', i, e);
      }
    }
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
    try {
      const parsed = new URL(url.toString(), window.location.href);
      const host = parsed.hostname;
      const path = parsed.pathname;
      // Solo interceptar peticiones a dominios de Google relacionados con Find My Device
      return (
        (host === 'www.google.com' && (path.includes('/android/find') || path.includes('/_/FindDevice'))) ||
        host === 'findmydevice.google.com' ||
        (host === 'android.google.com' && path.startsWith('/find')) ||
        (host === 'www.googleapis.com' && (path.includes('/devicemanagement') || path.includes('/android'))) ||
        (host === 'androiddevicemanager.googleapis.com')
      );
    } catch {
      return false;
    }
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
    
    log('Procesando datos de red...');
    
    // Buscar estructura de dispositivos en la respuesta
    const devices = findDevicesInObject(data);
    if (devices.length > 0) {
      log('Dispositivos encontrados en respuesta de red:', devices.length);
      
      let hasNewLocationData = false;
      
      // Merge con datos existentes (preferir datos de red más completos)
      const existingNames = new Set(networkData.map(d => (d.name || '').toLowerCase()));
      devices.forEach(d => {
        if (d.name && !existingNames.has(d.name.toLowerCase())) {
          networkData.push(d);
          log('Nuevo dispositivo de red agregado:', d.name, 'ubicación:', d.location ? 'sí' : 'no');
          if (d.location) hasNewLocationData = true;
        } else if (d.name) {
          // Actualizar el existente con datos nuevos, especialmente ubicación
          const idx = networkData.findIndex(nd => nd.name?.toLowerCase() === d.name.toLowerCase());
          if (idx >= 0) {
            const oldLocation = networkData[idx].location;
            const newLocation = d.location;
            
            // Merge de datos
            networkData[idx] = { ...networkData[idx], ...d };
            
            // Detectar si la ubicación cambió
            if (newLocation && JSON.stringify(oldLocation) !== JSON.stringify(newLocation)) {
              hasNewLocationData = true;
              log('Ubicación actualizada para:', d.name, 'lat:', newLocation.lat, 'lng:', newLocation.lng);
            }
          }
        }
      });
      
      // Notificar al dashboard si hay datos nuevos de ubicación
      if (hasNewLocationData) {
        log('Datos de ubicación nuevos detectados, notificando dashboard...');
        notifyDashboard();
      }
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
            `net-${Date.now()}-${(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2))}`,
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

  // Número máximo de intentos para enganchar el API de Google Maps (1 intento/seg = 30 seg)
  const MAX_GOOGLE_MAPS_HOOK_ATTEMPTS = 30;

  // Enganchar el API de Google Maps para capturar posiciones de marcadores
  function hookGoogleMapsAPI() {
    let attempts = 0;
    function tryHook() {
      attempts++;
      const gm = window.google && window.google.maps;
      if (!gm) {
        if (attempts < MAX_GOOGLE_MAPS_HOOK_ATTEMPTS) setTimeout(tryHook, 1000);
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
  async function notifyDashboard() {
    try {
      const devices = await extractDevices();
      
      // Merge con datos de red si existen
      const mergedDevices = devices.map(device => {
        const netData = networkData.find(nd => nd.name?.toLowerCase() === device.name.toLowerCase());
        if (netData && netData.location && !device.location) {
          return { ...device, location: netData.location };
        }
        return device;
      });
      
      log('Notificando dashboard con', mergedDevices.length, 'dispositivos');
      
      // Guardar en storage
      chrome.storage.local.set({ devices: mergedDevices, lastUpdate: Date.now() });
      
      // Enviar al background script con manejo de errores
      try {
        chrome.runtime.sendMessage({
          type: 'DEVICES_UPDATE',
          devices: mergedDevices
        }, (response) => {
          if (chrome.runtime.lastError) {
            log('Error enviando mensaje al background:', chrome.runtime.lastError.message);
          }
        });
      } catch (e) {
        log('Error en chrome.runtime.sendMessage:', e.message);
      }
    } catch (e) {
      log('Error en notifyDashboard:', e.message, e.stack);
    }
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
      try {
        chrome.runtime.sendMessage({ type: 'GET_DEVICES' }, (response) => {
          try {
            if (chrome.runtime.lastError) {
              log('Error getting devices:', chrome.runtime.lastError.message);
            }
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
          } catch (e) {
            log('Error posting devices response:', e.message);
          }
        });
      } catch (e) {
        log('Error sending GET_DEVICES message:', e.message);
      }
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
      try {
        chrome.runtime.sendMessage({
          type: 'OPEN_FIND_MY_DEVICE',
          background: event.data.background,
        }, (response) => {
          if (chrome.runtime.lastError) {
            log('Error in OPEN_FIND_MY_DEVICE:', chrome.runtime.lastError.message);
          }
        });
      } catch (e) {
        log('Error sending OPEN_FIND_MY_DEVICE:', e.message);
      }
      return;
    }
  });

  // Escuchar mensajes del background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message.type === 'GET_DEVICES') {
        extractDevices().then(devices => {
          sendResponse({ devices });
        }).catch(e => {
          log('Error obteniendo dispositivos:', e.message);
          sendResponse({ error: e.message });
        });
        return true; // Indica que sendResponse será llamado asincronamente
      }
      
      if (message.type === 'START_MONITORING') {
        startMonitoring(message.interval || 5000);
        sendResponse({ status: 'started' });
        return true;
      }
      
      if (message.type === 'STOP_MONITORING') {
        stopMonitoring();
        sendResponse({ status: 'stopped' });
        return true;
      }
    } catch (e) {
      log('Error en chrome.runtime.onMessage listener:', e.message);
      sendResponse({ error: e.message });
      return true;
    }
  });

  // Iniciar monitoreo continuo
  function startMonitoring(interval = 5000) {
    if (isMonitoring) return;
    
    isMonitoring = true;
    
    // Variable para rastrear dispositivos que ya han sido clickeados
    let clickedDevices = new Set();
    
    monitorInterval = setInterval(async () => {
      try {
        const devices = await extractDevices();
        
        // Detectar cambios
        const hasChanges = JSON.stringify(devices) !== JSON.stringify(lastDevices);
        
        if (hasChanges) {
          lastDevices = devices;
          notifyDashboard();
          
          // Detectar dispositivos nuevos que no han sido clickeados
          const newDevices = devices.filter(d => {
            const key = (d.name || '').toLowerCase();
            return !clickedDevices.has(key) && !d.location;
          });
          
          if (newDevices.length > 0) {
            log('Dispositivos nuevos sin ubicación detectados:', newDevices.length);
            // Hacer clic en los nuevos dispositivos para extraer ubicaciones
            simulateUserClicks(newDevices);
            
            // Marcar como clickeados
            newDevices.forEach(d => {
              clickedDevices.add((d.name || '').toLowerCase());
            });
          }
          
          // Notificar cambios
          try {
            chrome.runtime.sendMessage({
              type: 'DEVICES_CHANGED',
              devices: devices,
              timestamp: Date.now()
            }, (response) => {
              if (chrome.runtime.lastError) {
                log('Error en DEVICES_CHANGED:', chrome.runtime.lastError.message);
              }
            });
          } catch (e) {
            log('Error enviando DEVICES_CHANGED:', e.message);
          }
        }
      } catch (e) {
        log('Error en monitoring loop:', e.message);
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
  window.__deviceTrackerSimulateClicks = simulateUserClicks;
  window.__deviceTrackerNetworkData = () => getNetworkData();

  // Enganchar el API de Google Maps lo antes posible
  hookGoogleMapsAPI();
  
  // Iniciar monitoreo automaticamente con delay mayor para esperar carga
  setTimeout(() => {
    log('=== INICIANDO SISTEMA DE EXTRACCIÓN DE DISPOSITIVOS ===');
    log('Tiempo de espera completado, iniciando análisis...');
    
    // Análisis de DOM
    const analysis = analyzeDOMStructure();
    log('Análisis de DOM completado:', analysis);
    
    // Iniciar extracción de dispositivos
    extractDevices().then(devices => {
      log('Dispositivos iniciales extraídos:', devices.length);
      devices.forEach(d => {
        log(`  - ${d.name} (${d.source}) | Batería: ${d.battery}% | Ubicación: ${d.location ? 'sí' : 'no'}`);
      });
    });
    
    // Iniciar monitoreo continuo
    startMonitoring(5000);
    log('Monitoreo continuo iniciado');
    
    // Notificar al dashboard
    notifyDashboard();
    log('Notificación inicial enviada al dashboard');
  }, 4000);

})();
