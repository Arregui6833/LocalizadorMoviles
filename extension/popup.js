// Popup script
document.addEventListener('DOMContentLoaded', () => {
  const deviceListEl = document.getElementById('deviceList');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const lastUpdateEl = document.getElementById('lastUpdate');
  const openFindMyDeviceBtn = document.getElementById('openFindMyDevice');
  const refreshBtn = document.getElementById('refreshBtn');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const analysisResult = document.getElementById('analysisResult');
  const analysisText = document.getElementById('analysisText');

  // Cargar dispositivos del storage
  function loadDevices() {
    chrome.storage.local.get(['devices', 'lastUpdate'], (result) => {
      if (result.devices && result.devices.length > 0) {
        renderDevices(result.devices);
        updateStatus(true);
        if (result.lastUpdate) {
          lastUpdateEl.textContent = `Actualizado: ${formatTime(result.lastUpdate)}`;
        }
      } else {
        renderEmptyState();
        updateStatus(false);
      }
    });
  }

  // Renderizar dispositivos
  function renderDevices(devices) {
    deviceListEl.innerHTML = devices.map(device => `
      <div class="device-item">
        <div class="device-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
            <line x1="12" y1="18" x2="12" y2="18"/>
          </svg>
        </div>
        <div class="device-info">
          <div class="device-name">${escapeHtml(device.name)}</div>
          <div class="device-meta">
            ${device.battery ? `<span class="battery">${getBatteryIcon(device.battery)} ${device.battery}%</span>` : ''}
            ${device.location?.address ? `<span>${escapeHtml(device.location.address.substring(0, 20))}...</span>` : ''}
          </div>
        </div>
      </div>
    `).join('');
  }

  // Renderizar estado vacio
  function renderEmptyState() {
    deviceListEl.innerHTML = `
      <div class="empty-state">
        <p>No hay dispositivos detectados</p>
        <button class="btn" id="openFindMyDevice">Abrir Find My Device</button>
        <button class="btn btn-secondary" id="refreshBtn">Actualizar</button>
      </div>
    `;
    
    document.getElementById('openFindMyDevice')?.addEventListener('click', openFindMyDevice);
    document.getElementById('refreshBtn')?.addEventListener('click', loadDevices);
  }

  // Actualizar estado
  function updateStatus(connected) {
    statusDot.classList.toggle('offline', !connected);
    statusText.textContent = connected ? 'Monitoreando' : 'Desconectado';
  }

  // Abrir Find My Device
  function openFindMyDevice() {
    chrome.tabs.create({ url: 'https://www.google.com/android/find' });
  }

  // Formatear tiempo
  function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }

  // Icono de bateria
  function getBatteryIcon(level) {
    if (level > 80) return '🔋';
    if (level > 50) return '🔋';
    if (level > 20) return '🪫';
    return '🪫';
  }

  // Escapar HTML
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Analizar DOM
  async function analyzeDOM() {
    analysisResult.style.display = 'block';
    analysisText.textContent = 'Analizando...';
    
    try {
      // Obtener tab activa de Find My Device
      const tabs = await chrome.tabs.query({ url: '*://www.google.com/android/find*' });
      
      if (tabs.length === 0) {
        analysisText.textContent = 'No hay pestanas de Find My Device abiertas.\n\nAbre https://www.google.com/android/find primero.';
        return;
      }
      
      // Enviar mensaje al content script
      chrome.tabs.sendMessage(tabs[0].id, { type: 'ANALYZE_DOM' }, (response) => {
        if (chrome.runtime.lastError) {
          analysisText.textContent = `Error: ${chrome.runtime.lastError.message}\n\nRecarga la pagina de Find My Device.`;
          return;
        }
        
        if (response?.analysis) {
          analysisText.textContent = JSON.stringify(response.analysis, null, 2);
        } else {
          analysisText.textContent = 'No se recibio respuesta del content script.';
        }
      });
    } catch (err) {
      analysisText.textContent = `Error: ${err.message}`;
    }
  }

  const bgMonitorBtn = document.getElementById('bgMonitorBtn');
  const bgMonitorLabel = document.getElementById('bgMonitorLabel');
  const bgMonitorDot = document.getElementById('bgMonitorDot');

  // Cargar y mostrar estado del monitoreo en segundo plano
  function loadBgMonitorState() {
    chrome.storage.local.get(['backgroundMonitoring'], (result) => {
      updateBgMonitorUI(!!result.backgroundMonitoring);
    });
  }

  function updateBgMonitorUI(active) {
    if (active) {
      bgMonitorBtn.classList.add('active');
      bgMonitorLabel.textContent = 'Monitoreo en segundo plano: ACTIVO';
    } else {
      bgMonitorBtn.classList.remove('active');
      bgMonitorLabel.textContent = 'Monitoreo en segundo plano';
    }
  }

  bgMonitorBtn?.addEventListener('click', () => {
    chrome.storage.local.get(['backgroundMonitoring'], (result) => {
      const newState = !result.backgroundMonitoring;
      chrome.runtime.sendMessage({ type: 'SET_BACKGROUND_MONITORING', enable: newState }, (response) => {
        // Update UI only when background confirms the state change
        if (response && (response.status === 'enabled' || response.status === 'disabled')) {
          updateBgMonitorUI(newState);
        }
      });
    });
  });

  loadBgMonitorState();

  // Event listeners
  openFindMyDeviceBtn?.addEventListener('click', openFindMyDevice);
  refreshBtn?.addEventListener('click', loadDevices);
  analyzeBtn?.addEventListener('click', analyzeDOM);

  // Escuchar actualizaciones
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.devices) {
      loadDevices();
    }
    if (changes.backgroundMonitoring) {
      updateBgMonitorUI(!!changes.backgroundMonitoring.newValue);
    }
  });

  // Cargar al inicio
  loadDevices();
});
