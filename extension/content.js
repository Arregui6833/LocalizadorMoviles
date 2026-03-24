// Content script que se inyecta en Google Find My Device
// Extrae informacion de los dispositivos del DOM

(function() {
  'use strict';

  const EXTENSION_ID = 'device-tracker-monitor';
  let lastDevices = [];
  let isMonitoring = false;
  let monitorInterval = null;
  // Guard para evitar simulaciones de clics concurrentes
  let isClickingDevices = false;

  // Debug mode
  const DEBUG = true;
  function log(...args) {
    if (DEBUG) console.log('[DeviceTracker]', ...args);
  }

  // Determinar si la pestaña actual es la página de Google Find My Device.
  // El content script se inyecta también en el dashboard (localhost/vercel), así
  // que hay que limitar las operaciones de extracción y clic a la página correcta.
  function isFindMyDevicePage() {
    const host = window.location.hostname;
    const path = window.location.pathname;
    return (
      (host === 'www.google.com' && path.includes('/android/find')) ||
      host === 'findmydevice.google.com' ||
      (host === 'android.google.com' && path.startsWith('/find'))
    );
  }

  // Normalizar nombre de dispositivo (elimina acentos, puntuación y espacios extra).
  // Se usa como clave de deduplicación en stableDeviceCache y en el merge.
  function normalizeName(name) {
    if (!name) return '';
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Comprueba si una ubicación tiene coordenadas o dirección reales (no solo un objeto vacío).
  // Evita sobreescribir ubicaciones conocidas con objetos de ubicación vacíos.
  function hasRealLocation(loc) {
    return loc != null && (loc.lat != null || (typeof loc.address === 'string' && loc.address.length > 0));
  }

  // Regex para validar coordenadas en formato "lat,lng" — usado en múltiples partes del script.
  const COORD_ATTR_RE = /^(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)$/;

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

    // Estrategia 5: Atributo position="lat,lng" (Google Maps Web Components)
    const extractedFromPosition = extractFromPositionAttributes();

    log('Desde texto:', extractedFromText.length);
    log('Desde elementos:', extractedFromInteractive.length);
    log('Desde red:', extractedFromNetwork.length);
    log('Desde globales:', extractedFromGlobals.length);
    log('Desde atributo position:', extractedFromPosition.length);

    // Combinar resultados
    devices.push(...extractedFromText);
    devices.push(...extractedFromInteractive);
    devices.push(...extractedFromNetwork);
    devices.push(...extractedFromGlobals);
    devices.push(...extractedFromPosition);

    // Eliminar duplicados por nombre/id
    // normalizeName se define a nivel de módulo (ver arriba)
    const isGeneratedId = (id) => {
      if (!id) return true;
      return /^(text|interactive|panel|marker|pos)-/.test(id);
    };

    const map = new Map();

    devices.forEach((device) => {
      // Usar solo el nombre normalizado como clave de deduplicación.
      // Incluir battery/lastSeen en la clave causaría duplicados cuando esos valores
      // difieren entre estrategias de extracción (p.ej. text-scan vs. network).
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

    // Filter out devices with no useful info (likely false positives).
    // Also reject names that still contain transient Google FMD status strings
    // (e.g. "Galaxy S25Estableciendo conexión con el dispositivo...") which appear
    // when a device is clicked and the UI shows a connecting animation.
    const TRANSIENT_NAME_RE = /estableciendo\s+conexi[oó]n|connecting\s+to|buscando\s+ubicaci[oó]n|localizando\s+dispositivo|searching\s+for\s+location/i;
    const filteredDevices = uniqueDevices.filter(device =>
      device.name && device.name.length > 1 && device.name.length < 100 &&
      !TRANSIENT_NAME_RE.test(device.name)
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

    // Asignar coordenadas anónimas de atributos [position] a dispositivos sin ubicación real
    if (positionCoords.length > 0) {
      let posIdx = 0;
      filteredDevices.forEach(device => {
        if (!hasRealLocation(device.location) && posIdx < positionCoords.length) {
          const pc = positionCoords[posIdx++];
          device.location = { lat: pc.lat, lng: pc.lng, address: null };
          // Si el dispositivo no tiene batería y la coords anónima la tiene, usarla
          if (device.battery == null && pc.battery != null) {
            device.battery = pc.battery;
          }
          log('[position] Asignando coords anónimas a:', device.name, '→', pc.lat, pc.lng);
        }
      });
    }

    // Si aún no hay ubicación real, buscar coordenadas globales en la página
    const pageText = document.body.innerText;
    const globalCoords = extractCoordinatesFromText(pageText);
    if (globalCoords) {
      filteredDevices.forEach(device => {
        if (!hasRealLocation(device.location)) {
          device.location = globalCoords;
        }
      });
    }

    // Actualizar la caché estable: preservar ubicaciones conocidas, mantener IDs estables.
    // Solo se aceptan dispositivos con nombre válido para evitar que falsos positivos entren.
    filteredDevices.forEach(device => {
      if (!device.name || device.name.length < 2) return;
      const cacheKey = normalizeName(device.name);
      if (!cacheKey) return;
      const cached = stableDeviceCache.get(cacheKey);
      if (!cached) {
        stableDeviceCache.set(cacheKey, { ...device });
      } else {
        // Prefer a location that has real coordinates (lat/lng) over an address-only location.
        // This prevents a false "address: 'de DeviceName'" from overwriting real coordinates.
        const newHasCoords = device.location?.lat != null;
        const cachedHasCoords = cached.location?.lat != null;
        const mergedLocation = newHasCoords ? device.location
          : cachedHasCoords ? cached.location
          : hasRealLocation(device.location) ? device.location
          : (cached.location || device.location);

        stableDeviceCache.set(cacheKey, {
          ...cached,
          ...device,
          id: cached.id, // mantener el ID estable para que el dashboard no lo pierda
          location: mergedLocation,
          // Protect battery: once a battery value is cached (e.g. from a panel click), don't
          // overwrite it with a potentially false value from the next text-scan extraction.
          // simulateUserClicks updates the cache directly so real values still propagate.
          battery: cached.battery != null ? cached.battery : device.battery,
          // Prefer existing non-null lastSeen / activity over potentially missing new values.
          lastSeen: device.lastSeen || cached.lastSeen,
          activity: device.activity || cached.activity,
        });
      }
    });

    // Si tenemos datos de red con ubicación, actualizar la caché también
    networkData.forEach(nd => {
      if (!nd.name || !hasRealLocation(nd.location)) return;
      const cacheKey = normalizeName(nd.name);
      if (!cacheKey) return;
      const cached = stableDeviceCache.get(cacheKey);
      if (cached && !hasRealLocation(cached.location)) {
        stableDeviceCache.set(cacheKey, { ...cached, location: nd.location });
      }
    });

    // Asignar coordenadas de [position] anónimas a entradas de caché sin ubicación real
    if (positionCoords.length > 0) {
      let pi = 0;
      for (const [key, cached] of stableDeviceCache) {
        if (!hasRealLocation(cached.location) && pi < positionCoords.length) {
          const pc = positionCoords[pi++];
          const updated = { ...cached, location: { lat: pc.lat, lng: pc.lng, address: null } };
          if (cached.battery == null && pc.battery != null) updated.battery = pc.battery;
          stableDeviceCache.set(key, updated);
        }
      }
    }

    // Devolver la caché completa para que el dashboard vea TODOS los dispositivos conocidos
    // incluso cuando la SPA de Google FMD está en transición entre vistas
    const stableResult = Array.from(stableDeviceCache.values());

    // Intentar hacer clic en dispositivos que no tienen ubicación real para extraerla.
    // Incluye dispositivos con location=null, location vacía {lat:null}, o solo dirección sin coords.
    const devicesWithoutLocation = stableResult.filter(d => !hasRealLocation(d.location) || d.location?.lat == null);
    if (devicesWithoutLocation.length > 0) {
      simulateUserClicks(devicesWithoutLocation);
    }

    log('Dispositivos finales (caché estable):', stableResult.length, stableResult);
    return stableResult;
  }

  // Helper: delay en ms
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Helper: click un elemento con MouseEvent completo
  function clickElement(el) {
    if (!el) return;
    try {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        buttons: 1,
        clientX: rect.left + 10,
        clientY: rect.top + 10
      }));
      if (typeof el.click === 'function') el.click();
    } catch (e) {
      log('Error al clickear elemento:', e.message);
    }
  }

  // Función para simular clics en dispositivos de forma segura.
  // RE-BUSCA los contenedores en el DOM en cada iteración para evitar
  // referencias obsoletas después de que la SPA de Google navegue.
  async function simulateUserClicks(devices) {
    if (isClickingDevices) {
      log('Simulación de clics ya en progreso, saltando...');
      return;
    }

    if (!devices || devices.length === 0) return;

    isClickingDevices = true;
    log('Iniciando simulación de clics en', devices.length, 'dispositivos');

    // ── Pre-click: try to assign locations from stored API text ─────────────
    // The FMD API response often arrives BEFORE extractDevices() populates
    // stableDeviceCache.  parseFmdArrayFormat may have added entries to networkData
    // but could not update the cache because the device wasn't there yet.
    // Now that we know the device names (from the devices list), do a second pass
    // to fill in any remaining missing locations from the stored raw text.
    if (lastRawApiText) {
      const preAssigned = parseFmdArrayFormat(lastRawApiText);
      preAssigned.forEach(d => {
        const normKey = normalizeName(d.name);
        // Update stableDeviceCache
        const cached = stableDeviceCache.get(normKey);
        if (cached && !hasRealLocation(cached.location)) {
          stableDeviceCache.set(normKey, { ...cached, location: d.location });
          log('[pre-click] Ubicación pre-asignada:', d.name, d.location);
        }
        // Update networkData
        const existingNet = networkData.find(nd => normalizeName(nd.name) === normKey);
        if (existingNet && !hasRealLocation(existingNet.location)) {
          existingNet.location = d.location;
        } else if (!existingNet) {
          networkData.push({ ...d });
        }
      });
    }

    try {
      for (let i = 0; i < devices.length; i++) {
        const device = devices[i];
        const deviceName = (device.name || '').toLowerCase().trim();

        if (!deviceName) continue;

        log('=== DISPOSITIVO', i + 1, '/', devices.length, ':', device.name, '===');

        try {
          // PASO A: Asegurarse de estar en la vista de lista.
          // Si hay un botón Back visible, estamos en vista detallada → volver.
          const existingBack = findBackButton();
          if (existingBack) {
            log('Vista de detalle detectada, volviendo a lista...');
            clickElement(existingBack);
            await delay(2000);
          }

          // PASO B: Buscar el contenedor del dispositivo en el DOM ACTUAL (frescos, no caché).
          // Esto es esencial porque la SPA de Google re-renderiza los elementos al navegar.
          const freshContainers = findAllDeviceContainers();
          log('Contenedores frescos en el DOM:', freshContainers.length);

          if (freshContainers.length === 0) {
            log('❌ No hay contenedores en el DOM actual, abortando recorrido');
            break;
          }

          // Buscar el contenedor que tenga el nombre (o alguna palabra clave del nombre)
          const container = freshContainers.find(cont => {
            const text = cont.textContent?.toLowerCase().trim() || '';
            if (text.includes(deviceName)) return true;
            // Coincidencia parcial: usar palabras de más de 2 caracteres del nombre
            return deviceName.split(' ')
              .filter(w => w.length > 2)
              .some(w => text.includes(w));
          });

          if (!container) {
            log('❌ Contenedor no encontrado para:', device.name);
            continue;
          }

          // PASO C: Hacer clic en el elemento clickeable del contenedor
          const clickable = findClickableElementInList(container);
          if (!clickable) {
            log('❌ Elemento clickeable no encontrado para:', device.name);
            continue;
          }

          log('PASO C: Haciendo clic en dispositivo:', device.name);
          clickable.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await delay(300);

          // PASO C.1: Tomar snapshot de los [position] ANTES del clic para detectar cambios.
          // Cuando hacemos clic en un dispositivo, su marcador puede aparecer por primera vez
          // o moverse en el mapa → detectamos eso con el diff.
          const positionsBefore = new Map(); // element → positionValue
          document.querySelectorAll('[position]').forEach(el => {
            const pv = (el.getAttribute('position') || '').trim();
            if (COORD_ATTR_RE.test(pv)) positionsBefore.set(el, pv);
          });

          // Record the time of the click so we can correlate with network responses.
          const clickTime = Date.now();
          clickElement(clickable);

          log('✓ Click enviado, esperando carga de detalles...');
          // Esperar hasta que el panel de detalles aparezca (polling cada 400ms, máx 3s).
          // Esto evita el peor caso de esperar siempre 3s cuando el panel carga más rápido.
          {
            const DETAIL_SELECTOR = '[role="complementary"], [role="region"], aside, .detail-panel, #device-details, .device-details';
            let waited = 0;
            const MAX_WAIT = 3000;
            const POLL_INTERVAL = 400;
            while (waited < MAX_WAIT) {
              await delay(POLL_INTERVAL);
              waited += POLL_INTERVAL;
              const panelReady = document.querySelector(DETAIL_SELECTOR);
              const hasNewPosition = (() => {
                for (const el of document.querySelectorAll('[position]')) {
                  const pv = (el.getAttribute('position') || '').trim();
                  if (!COORD_ATTR_RE.test(pv)) continue;
                  if (!positionsBefore.has(el) || positionsBefore.get(el) !== pv) return true;
                }
                return false;
              })();
              // Also check if the map was panned/centered after the click
              const hasFreshMapCenter = lastMapCenter != null && lastMapCenter.timestamp > clickTime;
              if (panelReady && (hasNewPosition || hasFreshMapCenter)) {
                log('✓ Panel e indicador de posición detectados tras', waited, 'ms');
                break;
              }
              if (panelReady && waited >= POLL_INTERVAL * 3) {
                // Panel visible y esperamos al menos 1.2s adicionales — suficiente
                break;
              }
            }
          }

          // PASO C.2: Diff de [position] post-clic → ubicación específica del dispositivo clickeado.
          // Detecta elementos [position] nuevos o con valor cambiado tras el clic.
          let snapshotLocation = null;

          // PASO C.2a: Map center event (panTo/setCenter) received after the click.
          // This fires synchronously in FMD's click handler — reliable even in background tabs.
          if (lastMapCenter && lastMapCenter.timestamp > clickTime) {
            snapshotLocation = { lat: lastMapCenter.lat, lng: lastMapCenter.lng, address: null };
            log('[mapCenter] Posición capturada por Map.panTo/setCenter para', device.name, '→', snapshotLocation.lat, snapshotLocation.lng);
          }

          // PASO C.2b: Diff de [position] (fallback — only works in foreground when Maps renders)
          if (!snapshotLocation) {
            document.querySelectorAll('[position]').forEach(el => {
              if (snapshotLocation) return; // ya encontramos una
              const pv = (el.getAttribute('position') || '').trim();
              const m = pv.match(COORD_ATTR_RE);
              if (!m) return;
              const prevVal = positionsBefore.get(el);
              if (prevVal === undefined || prevVal !== pv) {
                // Elemento nuevo o con posición cambiada → pertenece al dispositivo clickeado
                const lat = parseFloat(m[1]);
                const lng = parseFloat(m[2]);
                if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
                  snapshotLocation = { lat, lng, address: null };
                  log('[snapshot] Posición detectada para', device.name, '→', lat, lng);
                }
              }
            });
          }

          // PASO C.3: Si el diff no encontró nada, buscar el marcador activo/seleccionado.
          // Google Maps puede marcar el marcador del dispositivo seleccionado con atributos/clases de estado.
          if (!snapshotLocation) {
            snapshotLocation = findSelectedPositionMarker();
            if (snapshotLocation) {
              log('[active-marker] Marcador activo para:', device.name, '→', snapshotLocation.lat, snapshotLocation.lng);
            }
          }

          // PASO C.4: Si aún no hay posición, buscar [position] en el subtree del panel de detalles.
          // El panel de detalles puede mostrar un mini-mapa con el marcador del dispositivo.
          if (!snapshotLocation) {
            const detailPanelForPos = document.querySelector(
              '[role="complementary"], [role="region"], aside, .detail-panel, #device-details, .device-details'
            );
            if (detailPanelForPos) {
              const panelPosEls = detailPanelForPos.querySelectorAll('[position]');
              for (const pel of panelPosEls) {
                const pv = (pel.getAttribute('position') || '').trim();
                const m = pv.match(COORD_ATTR_RE);
                if (m) {
                  const lat = parseFloat(m[1]);
                  const lng = parseFloat(m[2]);
                  if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
                    snapshotLocation = { lat, lng, address: null };
                    log('[detail-panel-pos] Posición en panel de detalles para:', device.name, '→', lat, lng);
                    break;
                  }
                }
              }
            }
          }

          // PASO C.5: Si solo hay UN elemento [position] válido en todo el DOM, es del dispositivo clickeado.
          // Esto ocurre cuando Google FMD muestra solo el marcador del dispositivo seleccionado.
          if (!snapshotLocation) {
            const allValidPositions = Array.from(document.querySelectorAll('[position]')).filter(el => {
              const pv = (el.getAttribute('position') || '').trim();
              return COORD_ATTR_RE.test(pv);
            });
            if (allValidPositions.length === 1) {
              const pv = (allValidPositions[0].getAttribute('position') || '').trim();
              const m = pv.match(COORD_ATTR_RE);
              if (m) {
                const lat = parseFloat(m[1]);
                const lng = parseFloat(m[2]);
                if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
                  snapshotLocation = { lat, lng, address: null };
                  log('[single-pos] Única posición en DOM para:', device.name, '→', lat, lng);
                }
              }
            }
          }

          // Capturar batería y lastSeen del panel de detalles para enriquecer el dispositivo
          let panelBattery = null;
          let panelLastSeen = null;
          try {
            const activePanel = document.querySelector(
              '[role="complementary"], [role="region"], aside, .detail-panel, #device-details, .device-details'
            );
            if (activePanel) {
              panelBattery = extractBatteryFromElement(activePanel);
              panelLastSeen = extractTimeFromElement(activePanel);
            }
          } catch(e) { /* ignorar */ }

          if (snapshotLocation) {
            // Actualizar directamente en stableDeviceCache para este dispositivo
            const cacheKey = normalizeName(device.name);
            const cached = stableDeviceCache.get(cacheKey);
            const enriched = {
              ...(cached || device),
              location: snapshotLocation,
              battery: panelBattery ?? cached?.battery ?? device.battery,
              lastSeen: panelLastSeen ?? cached?.lastSeen ?? device.lastSeen,
            };
            stableDeviceCache.set(cacheKey, enriched);
            // También en networkData para que otras partes del código lo encuentren
            const existingNet = networkData.find(d =>
              (d.name || '').toLowerCase() === deviceName ||
              (d.name || '').toLowerCase().includes(deviceName.split(' ')[0])
            );
            if (existingNet) {
              existingNet.location = snapshotLocation;
              if (panelBattery != null) existingNet.battery = panelBattery;
              if (panelLastSeen) existingNet.lastSeen = panelLastSeen;
            } else {
              networkData.push({ name: device.name, location: snapshotLocation, battery: panelBattery, lastSeen: panelLastSeen, source: 'position-snapshot' });
            }
            log('[snapshot] Caché actualizada para:', device.name, snapshotLocation);
          }

          // PASO D: Esperar captura de datos de ubicación desde la API interceptada
          log('PASO D: Esperando captura de ubicación desde API...');
          let locationCaptured = !!snapshotLocation; // ya tenemos ubicación si el diff funcionó
          if (!locationCaptured) {
            for (let t = 0; t < 5000; t += 500) {
              const netDevice = networkData.find(d =>
                d.name?.toLowerCase() === deviceName ||
                d.name?.toLowerCase().includes(deviceName.split(' ')[0])
              );
              if (netDevice?.location?.lat && netDevice?.location?.lng) {
                locationCaptured = true;
                log('✓ Ubicación capturada desde red:', netDevice.location);
                break;
              }
              await delay(500);
            }
          }

          // Si la red no capturó la ubicación, intentar extraerla del DOM del panel de detalles
          if (!locationCaptured) {
            log('⚠ Ubicación no capturada por red en 5s, intentando desde DOM...');
            const detailPanel = document.querySelector(
              '[role="complementary"], [role="region"], aside, .detail-panel, #device-details, .device-details'
            );
            // Para evitar asignar una posición incorrecta (de otro dispositivo), buscamos
            // primero en el panel de detalles; solo fallback a document si no hay panel.
            const domLocation = detailPanel
              ? extractLocationFromPanel(detailPanel)
              : extractLocationFromPanel(document);
            if (domLocation && hasRealLocation(domLocation)) {
              log('✓ Ubicación extraída del DOM para:', device.name, domLocation);
              // Guardar en networkData para que notifyDashboard la encuentre
              const existing = networkData.find(d =>
                d.name?.toLowerCase() === deviceName ||
                d.name?.toLowerCase().includes(deviceName.split(' ')[0])
              );
              if (existing) {
                existing.location = domLocation;
              } else {
                networkData.push({ name: device.name, location: domLocation, source: 'dom-panel' });
              }
              // Actualizar en stableDeviceCache directamente
              const ck = normalizeName(device.name);
              const cp = stableDeviceCache.get(ck);
              if (cp && !hasRealLocation(cp.location)) {
                stableDeviceCache.set(ck, { ...cp, location: domLocation });
              }
              locationCaptured = true;
            } else {
              log('⚠ Ubicación no disponible en DOM para:', device.name);
            }
          }

          // ── PASO D.2: Fallback de coordenadas de red (raw JSON scan) ────────────
          // When the DOM [position] approach and the named-device network lookup both fail
          // (common in background tabs where Google Maps doesn't render markers),
          // use the most recently captured coordinate that arrived AFTER this device's click.
          // Because simulateUserClicks processes one device at a time (guarded by
          // isClickingDevices), any coordinate received in this window almost certainly
          // belongs to the API response triggered by our click on this device.
          if (!locationCaptured) {
            const freshCoords = lastNetworkCoords.filter(c => c.timestamp > clickTime);
            if (freshCoords.length > 0) {
              // Use the most recent coordinate in the window
              const fc = freshCoords[freshCoords.length - 1];
              const rawNetLocation = { lat: fc.lat, lng: fc.lng, address: null };
              log('[rawNet] Usando coordenada de red para:', device.name, fc.lat, fc.lng);
              // Save to cache and networkData
              const cacheKey2 = normalizeName(device.name);
              const cached2 = stableDeviceCache.get(cacheKey2);
              if (cached2 && !hasRealLocation(cached2.location)) {
                stableDeviceCache.set(cacheKey2, { ...cached2, location: rawNetLocation });
              }
              const existingNet2 = networkData.find(d =>
                (d.name || '').toLowerCase() === deviceName ||
                (d.name || '').toLowerCase().includes(deviceName.split(' ')[0])
              );
              if (existingNet2) {
                existingNet2.location = rawNetLocation;
              } else {
                networkData.push({ name: device.name, location: rawNetLocation, source: 'raw-net-coords' });
              }
              locationCaptured = true;
            } else {
              log('⚠ Sin coordenadas de red frescas para:', device.name);
            }
          }

          // ── PASO D.3: Fallback — use lastMapCenter if it arrived after click ──
          // This covers the case where the raw JSON scan also found nothing but
          // the Map.panTo hook did fire (e.g. FMD used cached location data and
          // made no new network call, but still called panTo synchronously).
          if (!locationCaptured && lastMapCenter && lastMapCenter.timestamp > clickTime) {
            const mcLocation = { lat: lastMapCenter.lat, lng: lastMapCenter.lng, address: null };
            log('[mapCenter-D3] Usando lastMapCenter para:', device.name, mcLocation.lat, mcLocation.lng);
            const cacheKeyMC = normalizeName(device.name);
            const cachedMC = stableDeviceCache.get(cacheKeyMC);
            if (cachedMC && !hasRealLocation(cachedMC.location)) {
              stableDeviceCache.set(cacheKeyMC, { ...cachedMC, location: mcLocation });
            }
            const existingNetMC = networkData.find(d =>
              (d.name || '').toLowerCase() === deviceName ||
              (d.name || '').toLowerCase().includes(deviceName.split(' ')[0])
            );
            if (existingNetMC) {
              existingNetMC.location = mcLocation;
            } else {
              networkData.push({ name: device.name, location: mcLocation, source: 'map-center' });
            }
            locationCaptured = true;
          }

          // Notificar al dashboard si capturamos ubicación
          if (locationCaptured) {
            notifyDashboard();
          }

          // PASO E: Volver a la lista haciendo clic en Back
          log('PASO E: Volviendo a la lista...');
          const backButton = findBackButton();
          if (backButton) {
            log('✓ Botón Back encontrado, clickeando...');
            clickElement(backButton);
            await delay(2000);
            log('✓ Regresado a la lista');
          } else {
            log('❌ Botón Back no encontrado, usando history.back()...');
            window.history.back();
            await delay(2000);
          }

          log('✓ Dispositivo completado:', device.name);

        } catch (e) {
          log('❌ Error procesando dispositivo', device.name, ':', e.message);
          // Recuperación: intentar volver a la lista
          try {
            const backBtn = findBackButton();
            if (backBtn) { clickElement(backBtn); await delay(1500); }
            else { window.history.back(); await delay(1500); }
          } catch (e2) { /* ignorar */ }
        }
      }

      log('=== Completados todos los clics en dispositivos ===');

    } finally {
      isClickingDevices = false;
    }
  }

  // Encontrar el botón "Back" en la vista detallada
  function findBackButton() {
    // Selectores directos más comunes en Google Find My Device
    const directSelectors = [
      'button[aria-label="Back"]',
      'button[aria-label="Atrás"]',
      'button[aria-label="back"]',
      'button[aria-label="atras"]',
      '[jsname="LgbsSe"][aria-label*="Back"]',
      '[jsname="LgbsSe"][aria-label*="Atrás"]',
      '.VYBDae-Bz112c-LgbsSe[aria-label*="Back"]',
      '.VYBDae-Bz112c-LgbsSe[aria-label*="Atrás"]',
    ];

    for (const sel of directSelectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        log('Botón Back encontrado con selector:', sel);
        return btn;
      }
    }

    // Fallback: recorrer todos los botones buscando aria-label con "back"/"atrás"
    // o un icono de flecha hacia atrás
    const allButtons = document.querySelectorAll('button, [role="button"]');
    for (const btn of allButtons) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('back') || label.includes('atrás') || label.includes('atras')) {
        log('Botón Back encontrado por aria-label:', btn.getAttribute('aria-label'));
        return btn;
      }
      // Buscar icono de material "arrow_back" dentro del botón
      const icons = btn.querySelectorAll('i, .google-material-icons, .material-icons, [class*="icon"]');
      for (const icon of icons) {
        const iconText = (icon.textContent || '').trim();
        if (iconText === 'arrow_back' || iconText === 'arrow_back_ios') {
          log('Botón Back encontrado por icono de material');
          return btn;
        }
      }
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

  // Buscar el marcador de posición [position] que está actualmente "seleccionado" o "activo".
  // Se usa después de un clic en un dispositivo cuando el diff de snapshot no encontró cambios.
  // Google Maps puede marcar el marcador activo con atributos o clases de estado.
  function findSelectedPositionMarker() {
    const allPositionEls = document.querySelectorAll('[position]');
    for (const el of allPositionEls) {
      const pv = (el.getAttribute('position') || '').trim();
      const m = pv.match(COORD_ATTR_RE);
      if (!m) continue;

      // Comprobar si el elemento o algún ancestro cercano tiene indicadores de "seleccionado/activo"
      const isSelected =
        el.hasAttribute('selected') ||
        el.hasAttribute('active') ||
        el.hasAttribute('focused') ||
        el.getAttribute('aria-selected') === 'true' ||
        el.getAttribute('aria-current') === 'true' ||
        el.classList.contains('selected') ||
        el.classList.contains('active') ||
        el.classList.contains('focused') ||
        el.classList.contains('highlighted') ||
        el.closest('[selected], [active], [aria-selected="true"], .selected, .active, .highlighted, .focused') !== null;

      if (isSelected) {
        const lat = parseFloat(m[1]);
        const lng = parseFloat(m[2]);
        if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          log('[active-marker] Marcador seleccionado encontrado:', lat, lng);
          return { lat, lng, address: null };
        }
      }
    }
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

  // Limpiar el texto de un elemento eliminando los nombres de iconos Material Icon que se
  // filtran como texto (p.ej. "sound_sensing", "location_on") y etiquetas de botones de acción.
  // Devuelve el texto limpio o null si el resultado no sirve como nombre de dispositivo.
  // Selector para eliminar nodos de iconos dentro de un elemento clonado.
  const ICON_CHILD_SELECTOR =
    'i, .material-icons, .google-material-icons, [class*="material-icon"], ' +
    '[class*="googleMaterial"], .notranslate, [aria-hidden="true"]';

  function cleanElementText(el) {
    // Clonar el elemento para no modificar el DOM
    const clone = el.cloneNode(true);
    // Eliminar hijos que sean iconos (material-icons, google-material-icons, etc.)
    clone.querySelectorAll(ICON_CHILD_SELECTOR).forEach(n => n.remove());

    let text = (clone.textContent || '').trim();

    // Eliminar tokens sueltos de nombres de iconos Material (snake_case todo en minúsculas):
    // p.ej. "sound_sensing", "location_on", "battery_charging_full"
    // Estos son siempre snake_case minúsculas — los nombres reales de dispositivos no usan guiones bajos.
    text = text.replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, ' ').replace(/\s+/g, ' ').trim();

    return text || null;
  }

  // Generar un ID estable (no basado en timestamp) a partir del prefijo y el nombre
  // del dispositivo. Así el mismo dispositivo siempre recibe el mismo ID aunque el
  // content script se reinicie, evitando duplicados en el dashboard.
  function generateStableId(prefix, name) {
    if (!name) return `${prefix}-unknown-${Math.random().toString(36).slice(2, 8)}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return `${prefix}-${slug || 'device'}`;
  }

  // Eliminar sufijos de metadata que a veces se concatenan al nombre del dispositivo
  // sin espacio (p.ej. "Galaxy S25Visto por última vez: hace 2 minutos" → "Galaxy S25").
  // Esto ocurre porque el DOM de Google FMD coloca el nombre y el estado en elementos hermanos
  // y el textContent los une sin separador.
  function trimDeviceName(text) {
    if (!text) return '';
    return text
      .replace(/(?:Visto\s+por|visto\s+por|hace\s+\d+|en\s+l[íi]nea|offline|online|desconectado|conectado|activo\s+ahora|en\s+movimiento|last\s+seen|last\s+active|\d{1,3}\s*%|MO\b|Mo\b|restablecer|borrar|marcar\s+como|reproducir|silenciar|localizar|bloquear|protegido|protected|lost\s+mode|modo\s+perdido|estableciendo\s+conexi[oó]n|connecting|buscando\s+ubicaci[oó]n|localizando|searching|obteniendo\s+ubicaci[oó]n|getting\s+location|cargando|loading).*$/i, '')
      .trim();
  }

  // Prefijo que Google Find My Device pone en el aria-label de los marcadores del mapa:
  // p.ej. aria-label="Ubicación de Honor Pad 10"  → nombre real = "Honor Pad 10"
  // Quitar este prefijo evita que se cree un dispositivo falso "Ubicación de X".
  const LOCATION_LABEL_PREFIX_RE =
    /^(?:ubicaci[oó]n\s+de\s+|localizaci[oó]n\s+de\s+|posici[oó]n\s+de\s+|location\s+of\s+|location:\s*|position\s+of\s+)/i;

  function stripLocationLabelPrefix(name) {
    if (!name) return name;
    return name.replace(LOCATION_LABEL_PREFIX_RE, '').trim();
  }

  // Regex combinada de etiquetas de botones de acción y opciones de menú de Google Find My Device.
  // Estos elementos siempre generarían falsos positivos como nombres de dispositivos.
  const ACTION_BUTTON_RE =
    /^(?:reproducir\s+sonido|silenciar|localizar|marcar\s+como\s+perdido|borrar\s+dispositivo|bloquear|play\s+sound|locate|lock|erase|find|secure\s+device|ring|restablecer\s+el\s+estado\s+de\s+f[aá]brica(?:\s+del\s+dispositivo)?|factory\s+reset|reset\s+to\s+factory|enable\s+lost\s+mode|mark\s+as\s+lost|erase\s+device|modo\s+perdido|lost\s+mode|protected\s+by\s+google|protegido\s+por\s+google|activar\s+modo\s+perdido|marcar\s+como\s+perdido|m[aá]s\s+opciones|more\s+options|more\s+actions|opciones\s+de\s+dispositivo)$/i;

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
    // Require ':' after the location keyword so that "Ubicación de Device" doesn't match as an address.
    const locationPattern = /(?:ubicaci[oó]n|direcci[oó]n|location|address):\s*(.+)/i;

    const foundNames = new Set();

    const normalize = (value) =>
      value
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();

    allElements.forEach((el) => {
      const rawText = el.textContent?.trim();
      if (!rawText || rawText.length > 200 || rawText.length < 2) return;

      // Omitir elementos dentro de menús (son opciones de menú, no dispositivos)
      if (
        el.getAttribute('role') === 'menuitem' ||
        el.getAttribute('role') === 'menu' ||
        el.closest('[role="menu"]') !== null ||
        el.closest('[role="menubar"]') !== null
      ) return;

      // Omitir elementos que son botones de acción conocidos de Find My Device
      const isActionButton =
        el.tagName === 'BUTTON' ||
        el.getAttribute('role') === 'button' ||
        el.closest('button') !== null;

      if (isActionButton) {
        // Limpiar el texto de iconos antes de comparar con los patrones de acción
        const cleanedForCheck = cleanElementText(el) || rawText;
        if (ACTION_BUTTON_RE.test(cleanedForCheck.trim())) return;
      }

      const looksLikeDevice =
        devicePatterns.some((p) => p.test(rawText)) ||
        el.closest('[role="listitem"]') ||
        el.closest('[role="button"]');

      if (!looksLikeDevice) return;

      // Skip if text matches multiple device patterns (likely concatenated names)
      const patternMatches = devicePatterns.filter(p => p.test(rawText)).length;
      if (patternMatches > 1) return;

      // Limpiar el texto eliminando nombres de iconos Material Icon (snake_case) y
      // después recortar los sufijos de metadata que se concatenan sin espacio
      // (p.ej. "Galaxy S25Visto por última vez: hace 2 minutos" → "Galaxy S25")
      const cleaned = cleanElementText(el);
      if (!cleaned) return;
      // Quitar prefijos de etiqueta de ubicación (p.ej. "Ubicación de Galaxy S25" → "Galaxy S25")
      let name = stripLocationLabelPrefix(trimDeviceName(cleaned));
      if (!name || name.length < 2 || name.length > 120) return;

      // Omitir si después de limpiar es un texto de acción o menú
      if (ACTION_BUTTON_RE.test(name)) return;

      // Usar el nombre limpio como clave para evitar duplicados
      const key = normalize(name);
      if (foundNames.has(key)) return;
      foundNames.add(key);

      // Buscar en el contenedor principal del dispositivo.
      // Subir en el DOM hasta encontrar el contenedor más pequeño que incluya el porcentaje de batería.
      const container = findBestContainer(el);
      const containerText = container?.textContent || rawText;

      const batteryMatch = containerText.match(batteryPattern);
      const timeMatch = containerText.match(timePattern);
      const statusMatch = containerText.match(statusPattern);
      const locationMatch = containerText.match(locationPattern);
      const coords = extractCoordinatesFromText(containerText);

      devices.push({
        id: generateStableId('text', name),
        name,
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
        // Quitar prefijos de etiqueta de ubicación (p.ej. "Ubicación de Honor Pad 10" → "Honor Pad 10")
        const rawHeading = heading.textContent?.trim() || '';
        const name = stripLocationLabelPrefix(rawHeading);
        if (name && name.length > 1) {
          devices.push({
            id: generateStableId('panel', name),
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
    // 1) Check the `data-battery` attribute value directly (e.g. <div data-battery="30">)
    const dataBatVal = el.getAttribute ? el.getAttribute('data-battery') : null;
    if (dataBatVal !== null && dataBatVal !== '') {
      const attrVal = parseInt(dataBatVal, 10);
      if (!isNaN(attrVal) && attrVal >= 0 && attrVal <= 100) return attrVal;
    }
    // Also check descendant elements with data-battery attribute
    if (el.querySelector) {
      const dataBatEl = el.querySelector('[data-battery]');
      if (dataBatEl) {
        const attrVal2 = parseInt(dataBatEl.getAttribute('data-battery') || '', 10);
        if (!isNaN(attrVal2) && attrVal2 >= 0 && attrVal2 <= 100) return attrVal2;
      }
    }
    // 2) Fallback: look for percentage in text content
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

    // 0) Verificar la URL actual del navegador (cambia cuando se selecciona un dispositivo)
    try {
      const urlFull = window.location.href + ' ' + window.location.search + ' ' + window.location.hash;
      const urlCoords = extractCoordinatesFromText(urlFull);
      if (urlCoords && Math.abs(urlCoords.lat) <= 90 && Math.abs(urlCoords.lng) <= 180) {
        log('Coordenadas extraídas de la URL:', urlCoords);
        return urlCoords;
      }
    } catch (e) { /* ignorar */ }

    // 0b) Buscar en el DOM un atributo `position="lat,lng"` (Google Maps Web Components)
    try {
      const posEls = searchRoot.querySelectorAll('[position]');
      for (const pel of posEls) {
        const pv = (pel.getAttribute('position') || '').trim();
        const pm = pv.match(COORD_ATTR_RE);
        if (pm) {
          const lat = parseFloat(pm[1]);
          const lng = parseFloat(pm[2]);
          if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
            log('Coordenadas extraídas de atributo [position]:', lat, lng);
            return { lat, lng, address: null };
          }
        }
      }
      // Si el panel es document, buscar globalmente en todo el documento
      if (panel === document) {
        const allPosEls = document.querySelectorAll('[position]');
        for (const pel of allPosEls) {
          const pv = (pel.getAttribute('position') || '').trim();
          const pm = pv.match(COORD_ATTR_RE);
          if (pm) {
            const lat = parseFloat(pm[1]);
            const lng = parseFloat(pm[2]);
            if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
              log('Coordenadas globales desde atributo [position]:', lat, lng);
              return { lat, lng, address: null };
            }
          }
        }
      }
    } catch (e) { /* ignorar */ }

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
    if (coords && Math.abs(coords.lat) <= 90 && Math.abs(coords.lng) <= 180) {
      return coords;
    }

    // 3) Buscar elementos con datos de ubicación (atributos data-*, clases específicas)
    const addressEl = searchRoot.querySelector(
      '[data-address], .address, [data-ubicacion], .ubicacion, ' +
      '[jsname="WXaFdb"], [jsname="Bz112c"], .gws-localteam__location, ' +
      '[data-lat][data-lng]'
    );
    if (addressEl) {
      const lat = addressEl.getAttribute('data-lat');
      const lng = addressEl.getAttribute('data-lng');
      if (lat && lng) {
        return { lat: parseFloat(lat), lng: parseFloat(lng), address: addressEl.textContent?.trim() || null };
      }
      return { address: addressEl.textContent?.trim() || null, lat: null, lng: null };
    }

    // 4) Buscar texto que parezca dirección: "Ubicación: ...", "Última ubicación conocida: ...", etc.
    // Require ':' after the keyword so "Ubicación de DeviceName" doesn't match as a fake address.
    const addressMatch = panelText.match(
      /(?:(?:[uú]ltima\s+)?(?:ubicaci[oó]n|direcci[oó]n|location|address)(?:\s+conocida)?):\s*(.+)/i
    );
    if (addressMatch) {
      const address = addressMatch[1].trim();
      const coordsFromText = extractCoordinatesFromText(address);
      if (coordsFromText) return coordsFromText;
      if (address.length > 3 && address.length < 200) return { address, lat: null, lng: null };
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

    // 0) Atributo `position="lat,lng"` (Google Maps Web Components, gmp-advanced-marker, etc.)
    const posAttr = parent.getAttribute('position') || '';
    const posMatch = posAttr.match(/^(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)$/);
    if (posMatch) {
      const lat = parseFloat(posMatch[1]);
      const lng = parseFloat(posMatch[2]);
      if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat, lng, address: null };
      }
    }
    // Buscar descendiente con atributo position
    const posEl = parent.querySelector('[position]');
    if (posEl) {
      const pv = (posEl.getAttribute('position') || '').trim();
      const pm = pv.match(/^(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)$/);
      if (pm) {
        const lat = parseFloat(pm[1]);
        const lng = parseFloat(pm[2]);
        if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          return { lat, lng, address: null };
        }
      }
    }

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

  // Last map center event received from the MAIN-world interceptor.
  // Updated whenever FMD calls map.panTo/setCenter/fitBounds (even in background tabs).
  let lastMapCenter = null; // { lat, lng, timestamp }

  // Coordinate pairs extracted from raw API response text (used as a last-resort
  // fallback when findDevicesInObject can't parse Google's protobuf-JSON arrays).
  // Each entry: { lat, lng, timestamp }
  let lastNetworkCoords = [];

  // Latest raw FMD API response text — stored so we can re-process it after the
  // DOM device names become known (the API response often arrives before extractDevices
  // runs at the 4-second mark, when stableDeviceCache is still empty).
  let lastRawApiText = null;

  // Cache estable de dispositivos — preserva dispositivos y ubicaciones entre
  // actualizaciones del DOM (la SPA de Google FMD re-renderiza constantemente).
  // Solo los dispositivos con nombre válido (>1 char) entran en la caché.
  const stableDeviceCache = new Map(); // normalizedName → device

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

  // ── MAIN-world network interception → ISOLATED-world data bridge ──────────
  // The real fetch/XHR interception runs in the MAIN world (network-interceptor.js)
  // because Chrome MV3's isolated world cannot intercept the page's own network
  // calls.  That MAIN-world script dispatches CustomEvents on document, which we
  // receive here and feed into the existing processNetworkData / mapMarkers pipeline.
  document.addEventListener('dtNetData', function (event) {
    if (!isFindMyDevicePage()) return;
    const detail = event.detail;
    if (!detail) return;
    if (detail.type === 'network' && detail.data) {
      processNetworkData(detail.data, detail.rawText || null);
    } else if (detail.type === 'marker') {
      const lat = detail.lat;
      const lng = detail.lng;
      if (lat != null && lng != null) {
        mapMarkers.push({ lat: lat, lng: lng, title: detail.title || null });
        log('Marcador de mapa recibido del interceptor MAIN:', lat, lng);
      }
    } else if (detail.type === 'center') {
      // Map pan/center fired by FMD's click handler synchronously — works in background.
      const lat = detail.lat;
      const lng = detail.lng;
      if (lat != null && lng != null) {
        lastMapCenter = { lat, lng, timestamp: Date.now() };
        log('[mapCenter] Recibido del interceptor MAIN (', detail.method, '):', lat, lng);
      }
    }
  });

  // Extract lat/lng coordinate pairs from a raw JSON string using regex.
  // Google FMD's protobuf-JSON responses encode coordinates as bare numbers
  // in nested arrays, so field-name-based parsing (findDevicesInObject) misses them.
  // This regex finds any two adjacent floating-point numbers where the first is in
  // the lat range [-90, 90] and the second in the lng range [-180, 180].
  // Results are intentionally conservative (≥5 decimal places) to avoid false positives.
  function extractCoordsFromRawJson(text) {
    if (!text || typeof text !== 'string') return [];
    const results = [];
    // Match: <lat_number> <JSON separator(s)> <lng_number>
    // Requires ≥5 decimal places so we don't match short integers like version numbers.
    // Separator is limited to JSON array/object delimiters and whitespace to reduce
    // false positives from unrelated adjacent numbers in the response body.
    const re = /(-?\d{1,2}\.\d{5,})[\s,\[\]{}"':]{1,8}(-?\d{1,3}\.\d{5,})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (
        lat >= -90 && lat <= 90 &&
        lng >= -180 && lng <= 180 &&
        !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) // skip null-island
      ) {
        results.push({ lat, lng });
      }
    }
    return results;
  }

  // Parse FMD's protobuf-JSON array format to extract (device name, lat, lng) pairs.
  //
  // Google FMD's API responses encode device data as nested positional arrays without
  // named fields, so findDevicesInObject (which looks for keys like "name", "lat" etc.)
  // extracts nothing from them.  This function takes a different approach: it scans the
  // raw response text for JSON string literals that look like device names, then
  // searches the text window immediately following each name for coordinate pairs.
  //
  // Two name-matching strategies are combined:
  //   1. Brand-keyword filter — quickly matches strings containing known brand words.
  //   2. Known-name lookup — matches strings that exactly equal a device name already in
  //      stableDeviceCache or networkData, which handles custom nicknames and models that
  //      aren't in the brand keyword list (e.g. "Mi 11", "Find X5 Pro", "Moto G").
  //
  // The coordinate search window is 3000 chars (up from 1500) to handle longer responses
  // where name and coordinates are not immediately adjacent.
  function parseFmdArrayFormat(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];
    const results = [];
    const seen = new Set();

    // Build the set of known device names from cache and networkData for strategy 2.
    const knownNormNames = new Set();
    const knownNameMap = new Map(); // normName → original name
    for (const [normKey, dev] of stableDeviceCache) {
      if (dev.name && dev.name.length >= 2) {
        knownNormNames.add(normKey);
        knownNameMap.set(normKey, dev.name);
      }
    }
    networkData.forEach(d => {
      if (d.name && d.name.length >= 2) {
        const nk = normalizeName(d.name);
        if (nk) { knownNormNames.add(nk); knownNameMap.set(nk, d.name); }
      }
    });

    // Regex to find JSON string values (quoted, no backslash escapes, length 2–80)
    const stringRe = /"([^"\\]{2,80})"/g;
    // Device brand / model name pattern
    const deviceNameRE = /pixel|samsung|galaxy|iphone|xiaomi|redmi|oneplus|huawei|oppo|motorola|nokia|sony|asus|realme|vivo|poco|tablet|watch|honor|nothing|lg|ipad/i;

    let m;
    while ((m = stringRe.exec(rawText)) !== null) {
      const candidate = m[1];
      // Reject strings that look like URLs, paths, identifiers or JSON keys
      if (/[/\\<>{}[\]@=+]/.test(candidate)) continue;

      // Strategy 1: brand keyword match
      const isBrandMatch = deviceNameRE.test(candidate);
      // Strategy 2: known device name match (normalized comparison)
      const normCandidate = normalizeName(candidate);
      const isKnownDevice = normCandidate.length >= 2 && knownNormNames.has(normCandidate);

      if (!isBrandMatch && !isKnownDevice) continue;

      // Deduplicate by normalized candidate string
      if (seen.has(normCandidate)) continue;
      seen.add(normCandidate);

      // Look for coordinate pairs in the 3000 chars immediately after this name.
      const searchStart = m.index + m[0].length;
      const windowText = rawText.substring(searchStart, searchStart + 3000);
      const coords = extractCoordsFromRawJson(windowText);
      if (coords.length === 0) continue;

      // Use the canonical name from cache/networkData if available, otherwise clean up the candidate.
      const canonicalName = knownNameMap.get(normCandidate) || candidate;
      const cleanName = trimDeviceName(stripLocationLabelPrefix(canonicalName)) || canonicalName;
      if (!cleanName || cleanName.length < 2 || cleanName.length > 80) continue;

      results.push({
        id: generateStableId('fmd', cleanName),
        name: cleanName,
        location: { lat: coords[0].lat, lng: coords[0].lng, address: null },
        source: 'fmd-raw',
        extractedAt: new Date().toISOString(),
      });
      log('[fmd-raw] Nombre+coords extraídos del texto bruto:', cleanName, '→', coords[0].lat, coords[0].lng);
    }
    return results;
  }

  // Procesar datos de red
  function processNetworkData(data, rawText) {
    if (!data && !rawText) return;

    log('Procesando datos de red...');

    if (data) {
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

    // ── Raw-text coordinate extraction ───────────────────────────────────────
    // Google FMD's protobuf-JSON responses store coordinates as bare numbers in
    // nested arrays (no named fields), so findDevicesInObject misses them.
    // We scan the raw text for any number-pair that looks like lat/lng and store
    // it in lastNetworkCoords so simulateUserClicks can use it as a fallback.
    if (rawText) {
      const coords = extractCoordsFromRawJson(rawText);
      if (coords.length > 0) {
        const now = Date.now();
        coords.forEach(c => lastNetworkCoords.push({ lat: c.lat, lng: c.lng, timestamp: now }));
        // Keep only the most recent 30 entries to limit memory usage
        if (lastNetworkCoords.length > 30) {
          lastNetworkCoords = lastNetworkCoords.slice(-30);
        }
        log('[rawNet] Coordenadas extraídas del texto de red:', coords.length, coords[0]);
      }

      // Store for later re-processing when device names may not be in stableDeviceCache yet
      // (the API response often arrives before the 4-second DOM extraction runs).
      lastRawApiText = rawText;

      // ── FMD array format parser: extract (device name, location) pairs ──────
      // findDevicesInObject fails for FMD's positional-array protobuf-JSON format.
      // parseFmdArrayFormat correlates brand-name strings with nearby coordinate pairs.
      const fmdParsed = parseFmdArrayFormat(rawText);
      if (fmdParsed.length > 0) {
        let hasNewFmdLocation = false;
        fmdParsed.forEach(d => {
          const normKey = normalizeName(d.name);
          // Update networkData
          const existingNet = networkData.find(nd => normalizeName(nd.name) === normKey);
          if (existingNet) {
            if (!hasRealLocation(existingNet.location)) {
              existingNet.location = d.location;
              hasNewFmdLocation = true;
            }
          } else {
            networkData.push(d);
            hasNewFmdLocation = true;
          }
          // Update stableDeviceCache if the device is already known
          const cached = stableDeviceCache.get(normKey);
          if (cached && !hasRealLocation(cached.location)) {
            stableDeviceCache.set(normKey, { ...cached, location: d.location });
            log('[fmd-raw] stableDeviceCache actualizado:', d.name, d.location);
          }
        });
        if (hasNewFmdLocation) {
          log('[fmd-raw] Nuevas ubicaciones desde texto bruto, notificando dashboard...');
          notifyDashboard();
        }
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
            generateStableId('net', name),
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

  // Estrategia 5: Buscar elementos DOM con atributo `position="lat,lng"`.
  // Google Find My Device coloca las coordenadas de cada dispositivo en un atributo
  // `position` en elementos de tipo `gmp-advanced-marker` u otros componentes del mapa.
  // Ejemplo: <gmp-advanced-marker position="42.8469401,-2.6796923" ...>
  // También extrae la batería de atributos o texto cercano al mismo elemento.
  //
  // Devuelve dispositivos cuando tiene nombre real, y almacena las coords
  // en `positionCoords` para asignarlas a dispositivos sin ubicación.
  const positionCoords = []; // coords sin nombre, para asignación posterior

  function extractFromPositionAttributes() {
    const devices = [];
    // Limpiar coords anteriores (se re-populan en cada llamada)
    positionCoords.length = 0;

    const candidates = document.querySelectorAll('[position]');
    if (candidates.length === 0) return devices;

    const BATTERY_RE = /(\d{1,3})\s*%/;

    candidates.forEach((el, idx) => {
      const posVal = (el.getAttribute('position') || '').trim();
      const match = posVal.match(COORD_ATTR_RE);
      if (!match) return;

      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      if (isNaN(lat) || isNaN(lng)) return;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;

      const location = { lat, lng, address: null };

      // Intentar extraer el nombre del dispositivo desde el elemento o sus
      // padres / hermanos más cercanos.
      let name = null;
      // 1) aria-label, title, data-name, data-device-name, label del propio elemento
      name =
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('data-name') ||
        el.getAttribute('data-device-name') ||
        el.getAttribute('label') ||
        el.getAttribute('alt') ||
        null;
      // 2) Si no, buscar en los hijos del elemento (light DOM)
      if (!name) {
        const textChild = el.querySelector('[aria-label], [title], .device-name, h1, h2, h3, strong, span, div');
        if (textChild) {
          name = textChild.getAttribute('aria-label') || textChild.getAttribute('title') || textChild.textContent?.trim() || null;
        }
      }
      // 2b) Shadow DOM del elemento (gmp-advanced-marker usa shadow DOM para su contenido interno)
      if (!name) {
        try {
          const shadowRoot = el.shadowRoot;
          if (shadowRoot) {
            const shadowEl = shadowRoot.querySelector('[aria-label], [title], .device-name, .label, .marker-label, h1, h2, h3, strong');
            if (shadowEl) {
              name = shadowEl.getAttribute('aria-label') || shadowEl.getAttribute('title') || shadowEl.textContent?.trim() || null;
            }
          }
        } catch(e) { /* shadowRoot puede no ser accesible en algunos contextos */ }
      }
      // 3) Si aún no, ir al padre y buscar texto/atributo que parezca nombre de dispositivo
      if (!name) {
        let ancestor = el.parentElement;
        let levels = 0;
        while (ancestor && levels < 6) {
          const ancestorLabel = ancestor.getAttribute('aria-label') || ancestor.getAttribute('title');
          if (ancestorLabel && ancestorLabel.length > 1 && ancestorLabel.length < 120) {
            name = ancestorLabel;
            break;
          }
          ancestor = ancestor.parentElement;
          levels++;
        }
      }
      // 4) Último recurso: texto visible del propio elemento (p.ej. burbuja del marcador con nombre del dispositivo)
      if (!name) {
        const ownText = (el.textContent || '').trim();
        // Solo aceptar si tiene entre 2 y 80 caracteres y contiene al menos una letra (cualquier script)
        if (ownText.length >= 2 && ownText.length <= 80 && /\p{L}/u.test(ownText)) {
          name = ownText;
        }
      }
      // Limpiar el nombre y quitar prefijo de etiqueta de ubicación.
      // Ejemplo: aria-label="Ubicación de Honor Pad 10" → name = "Honor Pad 10"
      if (name) {
        name = stripLocationLabelPrefix(trimDeviceName(name));
      }

      // Extraer batería desde el elemento hacia arriba
      let battery = null;
      let searchEl = el;
      for (let i = 0; i < 6 && searchEl; i++) {
        const al = searchEl.getAttribute('aria-label') || '';
        const bma = al.match(BATTERY_RE);
        if (bma) { battery = parseInt(bma[1], 10); break; }
        const t = searchEl.textContent || '';
        const bm = t.match(BATTERY_RE);
        if (bm) { battery = parseInt(bm[1], 10); break; }
        searchEl = searchEl.parentElement;
      }

      if (name && name.length >= 2 && name.length <= 120) {
        // Tiene nombre real → crear dispositivo completo.
        // El ID es estable (basado en el nombre) para que no cambie entre extracciones
        // y el dashboard pueda actualizar el dispositivo existente en lugar de crear uno nuevo.
        log(`[position] Encontrado con nombre: ${name} → lat:${lat} lng:${lng} bat:${battery}`);
        devices.push({
          id: generateStableId('pos', name),
          name,
          battery,
          lastSeen: null,
          activity: null,
          location,
          isOnline: true,
          source: 'position-attr',
          extractedAt: new Date().toISOString(),
        });
      } else {
        // Sin nombre → almacenar coords como candidato anónimo para asignar a otros dispositivos
        log(`[position] Coords sin nombre: lat:${lat} lng:${lng}`);
        positionCoords.push({ lat, lng, battery });
      }
    });

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

      // Merge con datos de red si existen.
      // Buscar coincidencia por nombre exacto O por primera palabra del nombre (p.ej. "Pixel 6a" ~ "Pixel")
      const mergedDevices = devices.map(device => {
        if (device.location) return device; // ya tiene ubicación, no pisar
        const nameLower = (device.name || '').toLowerCase();
        const firstWord = nameLower.split(' ')[0];
        const netData = networkData.find(nd => {
          if (!nd.name) return false;
          const ndName = nd.name.toLowerCase();
          return ndName === nameLower || ndName.includes(firstWord) || nameLower.includes(ndName.split(' ')[0]);
        });
        if (netData && netData.location) {
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
      // Reenviar DEVICES_UPDATE y DEVICES_CHANGED a la página web via postMessage.
      // Esto es necesario cuando este content script está inyectado en el dashboard
      // (localhost, etc.) y el background envía actualizaciones al tab del dashboard.
      if (message.type === 'DEVICES_UPDATE' || message.type === 'DEVICES_CHANGED') {
        window.postMessage(
          {
            ...message,
            source: EXTENSION_ID,
          },
          '*'
        );
        sendResponse({ forwarded: true });
        return true;
      }

      if (message.type === 'GET_DEVICES') {
        extractDevices().then(devices => {
          sendResponse({ devices });
        }).catch(e => {
          log('Error obteniendo dispositivos:', e.message);
          sendResponse({ error: e.message });
        });
        return true; // Indica que sendResponse será llamado asincronamente
      }

      // FORCE_REFRESH: background service worker triggers this periodically so the
      // content script pushes fresh device data even when the tab is in the background.
      // chrome.runtime.onMessage callbacks are not subject to the same 1-minute timer
      // throttling that setInterval faces in hidden tabs, so they fire more reliably.
      if (message.type === 'FORCE_REFRESH') {
        if (isFindMyDevicePage()) {
          extractDevices().then(devices => {
            lastDevices = devices;
            notifyDashboard();
            sendResponse({ devices, refreshed: true });
          }).catch(e => {
            log('Error en FORCE_REFRESH:', e.message);
            sendResponse({ error: e.message });
          });
        } else {
          sendResponse({ skipped: true });
        }
        return true;
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

      if (message.type === 'ANALYZE_DOM') {
        const analysis = analyzeDOMStructure();
        sendResponse({ analysis });
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

  // Observador de mutaciones para detectar cambios en el DOM.
  // Solo tiene sentido en la página de Find My Device.
  const observer = new MutationObserver((mutations) => {
    // Procesar cambios en atributo `position` inmediatamente para capturar coordenadas.
    // Cuando un marcador aparece o cambia posición, intentamos asociarlo al dispositivo
    // actualmente seleccionado en el panel de detalles.
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.attributeName === 'position') {
        const el = mutation.target;
        const pv = (el.getAttribute('position') || '').trim();
        const m = pv.match(COORD_ATTR_RE);
        if (!m) continue;
        const lat = parseFloat(m[1]);
        const lng = parseFloat(m[2]);
        if (isNaN(lat) || isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
        const location = { lat, lng, address: null };

        // Intentar identificar qué dispositivo está seleccionado en el panel de detalles
        const detailHeading = document.querySelector(
          '[role="complementary"] h1, [role="complementary"] h2, [role="complementary"] [role="heading"], ' +
          'aside h1, aside h2, .detail-panel h1, .detail-panel h2'
        );
        if (detailHeading) {
          // Quitar prefijo de etiqueta de ubicación para identificar el dispositivo real.
          // Ejemplo: heading = "Ubicación de Honor Pad 10" → selectedName = "Honor Pad 10"
          const selectedName = stripLocationLabelPrefix((detailHeading.textContent || '').trim());
          if (selectedName.length >= 2) {
            const cacheKey = normalizeName(selectedName);
            const cached = stableDeviceCache.get(cacheKey);
            if (cached && !hasRealLocation(cached.location)) {
              stableDeviceCache.set(cacheKey, { ...cached, location });
              log('[mutation] Posición asignada a dispositivo seleccionado:', selectedName, '→', lat, lng);
            }
          }
        }
      }
    }

    if (isMonitoring) {
      // Debounce para notificar al dashboard
      clearTimeout(observer._timeout);
      observer._timeout = setTimeout(() => {
        notifyDashboard();
      }, 500);
    }
  });

  // Iniciar observador solo en la página de Find My Device
  if (isFindMyDevicePage()) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-device-id', 'data-lat', 'data-lng', 'data-battery', 'position']
    });
  }

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
  
  // Notificar que la extension esta lista
  console.log('[Device Tracker] Extension loaded -', isFindMyDevicePage() ? 'Find My Device' : 'Dashboard');
  log('Ejecuta analyzeDOMStructure() en la consola para ver la estructura del DOM');
  
  // Exponer funcion globalmente para debug
  window.__deviceTrackerAnalyze = analyzeDOMStructure;
  window.__deviceTrackerSimulateClicks = simulateUserClicks;
  window.__deviceTrackerNetworkData = () => getNetworkData();

  // Expose a refresh function that the background service worker can call via
  // chrome.scripting.executeScript to force a data extract + push even in background tabs.
  window.__deviceTrackerRefresh = function() {
    if (!isFindMyDevicePage()) return;
    extractDevices().then(devices => {
      lastDevices = devices;
      notifyDashboard();
    }).catch(e => log('Error en __deviceTrackerRefresh:', e.message));
  };

  // Las operaciones de extracción, clic y monitoreo sólo tienen sentido en la página
  // de Google Find My Device. En el dashboard (localhost, vercel, etc.) el content script
  // sólo actúa como puente de mensajes (chrome.runtime.onMessage → window.postMessage).
  if (isFindMyDevicePage()) {
    // Enganchar el API de Google Maps lo antes posible
    hookGoogleMapsAPI();

    // Keep the background service worker alive by maintaining an open port.
    // The SW can then run its own fast interval to drive FORCE_REFRESH messages
    // to this content script without being subject to tab-throttling.
    (function maintainServiceWorkerConnection() {
      try {
        const port = chrome.runtime.connect({ name: 'keepAlivePort' });
        port.onDisconnect.addListener(() => {
          // Reconnect after a brief pause so we don't hammer on errors
          setTimeout(maintainServiceWorkerConnection, 5000);
        });
      } catch (e) {
        log('keepAlive port error:', e.message);
        setTimeout(maintainServiceWorkerConnection, 10000);
      }
    })();

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
  } else {
    log('Dashboard detectado: sólo actuando como puente de mensajes');
  }

})();

