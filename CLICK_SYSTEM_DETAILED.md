# 🎯 Sistema de Extracción de Ubicaciones - Guía Técnica

## Estructura HTML que Detectamos

Basado en la estructura que compartiste para "Honor Pad 10":

```html
<div class="NVStyd">           ← CONTENEDOR PRINCIPAL (encontrado por div.NVStyd)
  <div class="aeaNo">
    <img class="n9lgqf" 
         src="https://lh3.googleusercontent.com/..."
         alt="Device image">
  </div>
  <div class="vvsYQe">
    <div class="KaKp4c">Honor Pad 10</div>  ← NOMBRE DEL DISPOSITIVO
  </div>
</div>
```

## Algoritmo de Detección y Click

### Paso 1: Buscar Contenedor (`findAllDeviceContainers()`)
```javascript
// Estrategia 1 - Detecta div.NVStyd (estructura de Google)
const containers = document.querySelectorAll('div.NVStyd')
// Resultado: Encuentra 6 contenedores (uno por dispositivo)
```

### Paso 2: Mapear a Nombres (`simulateUserClicks()`)
```javascript
// Para cada dispositivo extraído (Honor Pad 10, Galaxy S25, etc.)
const deviceName = "Honor Pad 10"
const container = containers.find(c => 
  c.textContent.toLowerCase().includes(deviceName.toLowerCase())
)
// Resultado: Asocia dispositivo a su elemento DOM
```

### Paso 3: Encontrar Elemento Clickeable (`findClickableElement()`)
```javascript
// Busca en orden:
1. container.querySelector('button')          // ← Si hay botón
2. container.querySelector('[role="button"]') // ← Rol ARIA
3. container.querySelector('a')               // ← Link
4. container.querySelector('[tabindex="0"]')  // ← Elemento interactivo
5. Si nada, usa el contenedor mismo           // ← Fallback
```

### Paso 4: Simular Click Realista
```javascript
// 1. Scroll a la vista
clickable.scrollIntoView({ behavior: 'smooth', block: 'center' })

// 2. Crear MouseEvent con coordenadas correctas
const clickEvent = new MouseEvent('click', {
  bubbles: true,
  cancelable: true,
  view: window,
  buttons: 1,
  clientX: clickable.getBoundingClientRect().left + 10,
  clientY: clickable.getBoundingClientRect().top + 10
})

// 3. Dispatch del evento
clickable.dispatchEvent(clickEvent)
clickable.click()  // Fallback

// 4. Esperar respuesta de API (2.5 segundos)
await sleep(2500)
```

### Paso 5: Capturar Ubicación desde API
```javascript
// Mientras hacemos clic, la red intercepta las respuestas de Google:
// GET https://www.google.com/_/FindDevice/...
// GET https://www.googleapis.com/android/devicemanagement/...

// Respuesta capturada:
{
  "devices": [{
    "name": "Honor Pad 10",
    "location": {
      "lat": 40.1234,
      "lng": -3.5678,
      "address": "Madrid, España"
    }
  }]
}

// Procesada por processNetworkData():
// - Extrae ubicaciones con extractLocationFromObj()
// - Busca en la respuesta recursivamente
// - Notifica al dashboard con nuevas ubicaciones
```

## 📍 Mapeo de los 6 Dispositivos (Tu Captura)

```
┌─ Honor Pad 10 
│  ├─ Contenedor: div.NVStyd (imagen + nombre)
│  ├─ Elemento clickeable: div → click()
│  └─ Ubicación esperada: API response
│
├─ Galaxy S25
│  ├─ Contenedor: div.NVStyd (imagen + nombre)
│  ├─ Elemento clickeable: div → click()
│  └─ Ubicación esperada: API response
│
├─ Nothing Phone (1)
│  ├─ Contenedor: div.NVStyd (imagen + nombre)
│  ├─ Elemento clickeable: div → click()
│  └─ Ubicación esperada: API response
│
├─ WH-1000XM5 (Headphones)
│  ├─ Contenedor: div.NVStyd (imagen + nombre)
│  ├─ Elemento clickeable: div → click()
│  └─ Ubicación esperada: API response
│
├─ Sony de arregui (Headphones)
│  ├─ Contenedor: div.NVStyd (imagen + nombre)
│  ├─ Elemento clickeable: div → click()
│  └─ Ubicación esperada: API response
│
└─ JBL Xtreme 4 (Speaker)
   ├─ Contenedor: div.NVStyd (imagen + nombre)
   ├─ Elemento clickeable: div → click()
   └─ Ubicación esperada: API response
```

## 🔍 Validación en Console (F12)

```javascript
// 1. Ver estructura detectada
window.__deviceTrackerAnalyze()

// 2. Ver datos de red capturados
window.__deviceTrackerNetworkData()

// 3. Ver logs en tiempo real
// Abrir F12 → Console
// Filtrar por "[DeviceTracker]"
```

## 📊 Ejemplo de Logs Esperados

```
[DeviceTracker] === INICIANDO SISTEMA DE EXTRACCIÓN DE DISPOSITIVOS ===
[DeviceTracker] Tiempo de espera completado, iniciando análisis...
[DeviceTracker] Análisis de DOM completado: {
  dataElements: 8,
  lists: 2,
  headings: 5,
  batteryTexts: [{text: "75%", tag: "DIV", parent: "vvsYQe"}, ...],
  maps: 1,
  deviceMentions: 6
}
[DeviceTracker] Dispositivos iniciales extraídos: 6
  - Honor Pad 10 (text-scan) | Batería: 75% | Ubicación: no
  - Galaxy S25 (text-scan) | Batería: 85% | Ubicación: no
  - Nothing Phone (1) (text-scan) | Batería: 60% | Ubicación: no
  - WH-1000XM5 (text-scan) | Batería: 45% | Ubicación: no
  - Sony de arregui (text-scan) | Batería: 30% | Ubicación: no
  - JBL Xtreme 4 (text-scan) | Batería: 95% | Ubicación: no

[DeviceTracker] Iniciando simulación de clics en 6 dispositivos
[DeviceTracker] Contenedores de dispositivos encontrados: 6
[DeviceTracker] Dispositivos mapeados: 6 / 6

[DeviceTracker] Haciendo clic en dispositivo 1 / 6 : Honor Pad 10
[DeviceTracker] Encontrado button directo
[DeviceTracker] Click enviado a: Honor Pad 10
[DeviceTracker] Procesando datos de red...
[DeviceTracker] Dispositivos encontrados en respuesta de red: 1
[DeviceTracker] Ubicación actualizada para: Honor Pad 10 lat: 40.1234 lng: -3.5678
[DeviceTracker] Datos de ubicación nuevos detectados, notificando dashboard...
[DeviceTracker] Notificando dashboard con 6 dispositivos

[DeviceTracker] Haciendo clic en dispositivo 2 / 6 : Galaxy S25
[DeviceTracker] Encontrado elemento con role=button
[DeviceTracker] Click enviado a: Galaxy S25
[DeviceTracker] Ubicación actualizada para: Galaxy S25 lat: 40.4168 lng: -3.7038
...

[DeviceTracker] Completados todos los clics en dispositivos
```

## ⚡ Ventajas del Nuevo Sistema

1. **Múltiples estrategias de búsqueda**: No fallaría si Google cambia estructura
2. **Scroll automático**: Garantiza que elemento está en viewport
3. **Eventos realistas**: MouseEvent con coordenadas cliente reales
4. **Fallbacks**: 8 formas de encontrar elemento clickeable
5. **Timing inteligente**: 2.5 segundos esperan respuesta de API
6. **Logging detallado**: Fácil de debuggear si algo falla
7. **Sin bloqueos**: Operaciones asincrónicas, no bloquea UI
8. **Detección de cambios**: Solo notifica cuando hay datos nuevos

## 🔧 Debugging

Si no captura ubicaciones:

1. **Abrir console (F12)**
2. **Ver logs**: Filtrar por `[DeviceTracker]`
3. **Ejecutar**: `window.__deviceTrackerNetworkData()`
4. **Ejecutar**: `window.__deviceTrackerAnalyze()`
5. **Check**: 
   - ¿Se hacen los clicks?
   - ¿Aparecen datos en Network tab?
   - ¿Se capturan en networkData array?

---

**Última actualización**: 2025-03-16  
**Versión**: 1.0 - Sistema de clics automáticos en dispositivos
