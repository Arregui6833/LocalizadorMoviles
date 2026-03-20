# 🧪 Guía de Prueba - Sistema de Clics Automáticos

## Preparación

### 1. Recargar la Extensión
```
1. Abre Chrome
2. Ve a: chrome://extensions/
3. Busca "Device Tracker" (o tu ID de extensión)
4. Haz clic en el botón de recarga (🔄)
5. Verifica que muestra "Extension loaded" en la consola
```

### 2. Abre Google Find My Device
```
https://www.google.com/android/find
```

### 3. Abre la Consola del Navegador
```
Presiona: F12
Ve a: Console tab
```

## Pruebas

### Test 1: Verificar Inyección de Content Script
**Qué buscar en la consola:**
```
[DeviceTracker] === INICIANDO SISTEMA DE EXTRACCIÓN DE DISPOSITIVOS ===
[DeviceTracker] Tiempo de espera completado, iniciando análisis...
```

**✅ Si ves esto**: Content script se inyectó correctamente  
**❌ Si no lo ves**: La extensión no se inyectó (recargar página)

---

### Test 2: Verificar Análisis del DOM
**En la consola, ejecuta:**
```javascript
window.__deviceTrackerAnalyze()
```

**Salida esperada:**
```javascript
{
  dataElements: 8,           // Elementos con data-* attributes
  lists: 2,                  // Listas encontradas
  headings: 5,               // Encabezados
  batteryTexts: [...],       // Porcentajes de batería encontrados
  maps: 1,                   // Google Maps iframes/divs
  deviceMentions: 6          // Menciones de dispositivos Android
}
```

**✅ Si la estructura parece correcta**: DOM análisis funciona  
**❌ Si los números son muy bajos**: Posible problema con selectores

---

### Test 3: Verificar Extracción de Dispositivos
**Busca en los logs:**
```
[DeviceTracker] Dispositivos iniciales extraídos: 6
  - Honor Pad 10 (text-scan) | Batería: 75% | Ubicación: no
  - Galaxy S25 (text-scan) | Batería: 85% | Ubicación: no
  - Nothing Phone (1) (text-scan) | Batería: 60% | Ubicación: no
  ...
```

**✅ Si ves esto**: Extracción de dispositivos funciona  
**❌ Si no extrae dispositivos**: Revisar selectores de búsqueda

---

### Test 4: Verificar Sistema de Clics
**Busca en los logs:**
```
[DeviceTracker] Contenedores de dispositivos encontrados: 6
[DeviceTracker] Dispositivos mapeados: 6 / 6
[DeviceTracker] Haciendo clic en dispositivo 1 / 6 : Honor Pad 10
[DeviceTracker] Click enviado a: Honor Pad 10
```

**✅ Si ves esto**: Sistema de clics está funcionando  
**⚠️ Si dice 0 mapeados**: Problema encontrando contenedores  
**❌ Si no hace clics**: Revisar findClickableElement()

---

### Test 5: Verificar Captura de Ubicaciones desde API
**En la consola, ejecuta:**
```javascript
window.__deviceTrackerNetworkData()
```

**Salida esperada:**
```javascript
[
  {
    name: "Honor Pad 10",
    source: "network",
    location: {
      lat: 40.1234,
      lng: -3.5678,
      address: "Madrid, España"
    }
  },
  {
    name: "Galaxy S25",
    source: "network",
    location: {
      lat: 40.4168,
      lng: -3.7038,
      address: "Madrid, España"
    }
  },
  ...
]
```

**✅ Si ves ubicaciones**: Network interception funciona  
**❌ Si ves array vacío**: 
  - Ubicaciones no se están capturando de la API
  - Revisar shouldInterceptUrl()
  - Revisar processNetworkData()
  - Abrir Network tab y revisar si hay requests a google.com o googleapis.com

---

### Test 6: Verificar Notificación al Dashboard
**En la consola, busca:**
```
[DeviceTracker] Notificando dashboard con 6 dispositivos
```

**✅ Si ves esto**: Dashboard está recibiendo datos  
**❌ Si no lo ves**: Revisar notifyDashboard() y chrome.runtime.sendMessage()

---

### Test 7: Verificar Monitoreo Continuo
**En la consola, busca cada 5 segundos:**
```
[DeviceTracker] Detección de cambios...
[DeviceTracker] Dispositivos nuevos sin ubicación detectados: 0
```

**✅ Si ves esto**: Monitoreo está activo  
**❌ Si no lo ves**: startMonitoring() no se inició

---

## Problemas Comunes

### Problema: "Extension loaded" no aparece
```
❌ CAUSA: Content script no se inyectó
✅ SOLUCIÓN:
   1. Recargar la extensión (chrome://extensions)
   2. Recargar la página de Google Find My Device
   3. Verificar manifest.json tiene content_scripts correctamente
   4. Revisar que la URL coincide (google.com/android/find)
```

### Problema: Se detectan 0 dispositivos
```
❌ CAUSA: Selectores no coinciden con estructura HTML
✅ SOLUCIÓN:
   1. Ejecutar window.__deviceTrackerAnalyze()
   2. Revisar si batteryTexts es vacío
   3. Abrir inspector (F12 → Elements)
   4. Buscar div.NVStyd, [role="listitem"], etc.
   5. Actualizar selectores en extractFromPageText()
```

### Problema: Se detectan dispositivos pero sin ubicación
```
❌ CAUSA: Clics no se están haciendo o API no responde
✅ SOLUCIÓN:
   1. Ver si dice "Click enviado a: Honor Pad 10"
   2. Abrir Network tab (F12 → Network)
   3. Buscar requests a google.com o googleapis.com
   4. Verificar si hay respuestas JSON con ubicaciones
   5. Si no hay requests, revisar findClickableElement()
```

### Problema: Dashboard no muestra ubicaciones
```
❌ CAUSA: networkData no se está merging correctamente
✅ SOLUCIÓN:
   1. Ejecutar window.__deviceTrackerNetworkData()
   2. Ver si tiene datos con location
   3. Si está vacío, revisar processNetworkData()
   4. Si tiene datos, revisar notifyDashboard() merge logic
   5. Abrir browser console y revisar chrome.runtime.sendMessage()
```

### Problema: Errores en la consola
```
❌ Cualquier error que veas significa que algo falló
✅ SOLUCIÓN:
   1. Leer el mensaje de error completo
   2. Buscar la línea del error en content.js
   3. Revisar que la sintaxis es correcta
   4. Ejecutar: node -c extension/content.js
   5. Si es error en el código, revisar git diff
```

---

## Checklist de Prueba Completo

```
[ ] 1. Content script inyectado correctamente
[ ] 2. DOM análisis detecta estructura HTML
[ ] 3. Se extraen 6 dispositivos del DOM
[ ] 4. Se encuentran 6 contenedores en la página
[ ] 5. Se mapean 6 dispositivos a elementos
[ ] 6. Se hacen clics en los dispositivos
[ ] 7. Network intercepts requests de Google
[ ] 8. Se capturan ubicaciones (lat/lng)
[ ] 9. networkData array tiene 6 dispositivos con location
[ ] 10. Dashboard recibe notificación con ubicaciones
[ ] 11. Mapa muestra marcadores en ubicaciones correctas
[ ] 12. Monitoreo continuo está activo (cada 5 segundos)
```

---

## Datos para Verificación

Tu screenshot muestra estos 6 dispositivos:

| Dispositivo | Batería | Ubicación Esperada |
|-------------|---------|-------------------|
| Honor Pad 10 | 75% | Madrid (aprox) |
| Galaxy S25 | 85% | Madrid (aprox) |
| Nothing Phone (1) | 60% | Madrid (aprox) |
| WH-1000XM5 | 45% | Madrid (aprox) |
| Sony de arregui | 30% | Madrid (aprox) |
| JBL Xtreme 4 | 95% | Madrid (aprox) |

**Después de los clics, todos deberían tener `location.lat` y `location.lng`**

---

## Video esperado de la consola

```
[Carga Google Find My Device]
   ↓ (4 segundos de espera)
   ↓
[DeviceTracker] === INICIANDO SISTEMA DE EXTRACCIÓN DE DISPOSITIVOS ===
[DeviceTracker] Análisis de DOM completado: {...}
[DeviceTracker] Dispositivos iniciales extraídos: 6
[DeviceTracker] Contenedores encontrados: 6
[DeviceTracker] Dispositivos mapeados: 6 / 6
   ↓
[DeviceTracker] Haciendo clic en dispositivo 1 / 6 : Honor Pad 10
   [Pausa 2.5 segundos]
   [Network intercepta respuesta de Google]
[DeviceTracker] Ubicación actualizada para: Honor Pad 10 lat: 40.1234 lng: -3.5678
   ↓
[DeviceTracker] Haciendo clic en dispositivo 2 / 6 : Galaxy S25
   [Pausa 2.5 segundos]
[DeviceTracker] Ubicación actualizada para: Galaxy S25 lat: 40.4168 lng: -3.7038
   ↓
[... continúa con dispositivos 3-6 ...]
   ↓
[DeviceTracker] Completados todos los clics en dispositivos
[DeviceTracker] Notificando dashboard con 6 dispositivos
```

---

**¿Necesitas ayuda?**

Si algo no funciona:
1. Ejecuta los tests del 1 al 7
2. Nota en qué test falla
3. Revisa el archivo EXTENSION_IMPROVEMENTS.md
4. Busca esa sección en content.js
5. Revisa los comentarios del código

---

Última actualización: 2025-03-16  
Versión: 1.0 Testing Guide
