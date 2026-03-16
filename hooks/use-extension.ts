"use client";

import { useState, useEffect, useCallback } from "react";

export interface DeviceLocation {
  lat: number | null;
  lng: number | null;
  address?: string;
}

export interface Device {
  id: string;
  name: string;
  battery: number | null;
  lastSeen: string | null;
  activity?: string | null;
  location: DeviceLocation | null;
  isOnline: boolean;
  model?: string;
  extractedAt: string;
}

interface ExtensionState {
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  devices: Device[];
  lastUpdate: number | null;
  extensionId: string | null;
}

// ID de la extension - el usuario debe actualizarlo despues de instalar
const DEFAULT_EXTENSION_ID = "YOUR_EXTENSION_ID_HERE";
const STORAGE_KEY = "device-tracker:extension-id";

// Identificador que el content script incluye en los mensajes postMessage
const EXTENSION_WINDOW_SOURCE = "device-tracker-monitor";
const WINDOW_MESSAGE_TIMEOUT = 2500;

export function useExtension(extensionId?: string) {
  const [state, setState] = useState<ExtensionState>({
    isConnected: false,
    isLoading: true,
    error: null,
    devices: [],
    lastUpdate: null,
    extensionId: extensionId || null,
  });

  const normalizeExtensionId = (id: string) => {
    if (!id) return "";

    // Trim whitespace and remove surrounding chrome-extension:// prefix, slashes, and fragments.
    let cleaned = id.trim();
    cleaned = cleaned.replace(/^chrome-extension:\/\//i, "");
    cleaned = cleaned.replace(/\?.*$/, "");
    cleaned = cleaned.replace(/#.*$/, "");
    cleaned = cleaned.replace(/\/+$/, "");

    // Keep only alphanumeric chars to avoid pasting full URLs.
    cleaned = cleaned.replace(/[^a-z0-9]/gi, "");

    return cleaned.toLowerCase();
  };

  const isValidExtensionId = (id: string) => {
    // Chrome extension IDs are 32 chars using letters a-p.
    return /^[a-p]{32}$/.test(id);
  };

  // Cargar ID guardado (persistencia) para que no se pierda al recargar
  useEffect(() => {
    if (typeof window === "undefined") return;

    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const normalized = normalizeExtensionId(stored);
      setState((prev) => ({
        ...prev,
        extensionId: normalized,
        error: normalized
          ? isValidExtensionId(normalized)
            ? null
            : "El ID de la extensión no parece válido. Asegúrate de pegar solo el ID de 32 caracteres."
          : null,
      }));
    }
  }, []);

  // Enviar mensajes al content script mediante window.postMessage (sin necesitar el ID de la extensión)
  const sendWindowMessage = useCallback(
    (message: Record<string, any>, timeout = WINDOW_MESSAGE_TIMEOUT) => {
      return new Promise<any>((resolve) => {
        if (typeof window === "undefined") return resolve(null);

        const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const handler = (event: MessageEvent) => {
          if (event.source !== window) return;
          const data = event.data;
          if (!data || data.source !== EXTENSION_WINDOW_SOURCE) return;
          if (data.requestId !== requestId) return;

          window.removeEventListener("message", handler);
          clearTimeout(timer);
          resolve(data);
        };

        const timer = window.setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve(null);
        }, timeout);

        window.addEventListener("message", handler);
        // Asegurarnos de enviar solo datos clonables (evitar PointerEvent, DOM nodes, etc.)
        const payload = {
          ...message,
          requestId,
        };

        let safePayload: any = payload;
        try {
          safePayload = structuredClone(payload);
        } catch {
          try {
            safePayload = JSON.parse(JSON.stringify(payload));
          } catch {
            const type = (payload as any).type;
          safePayload = { type, requestId };
          }
        }

        window.postMessage(safePayload, "*");
      });
    },
    []
  );

  // Verificar conexion con la extension
  const checkConnection = useCallback(async () => {
    const id = state.extensionId;

    const setNotConnected = (message: string) => {
      setState((prev) => ({
        ...prev,
        isConnected: false,
        isLoading: false,
        error: message,
      }));
    };

    const tryWindowPing = async () => {
      const response = await sendWindowMessage({ type: "PING" });
      if (response && response.type === "PONG") {
        setState((prev) => ({
          ...prev,
          isConnected: true,
          isLoading: false,
          error: null,
        }));
        return true;
      }
      return false;
    };

    // Preferir conexión directa si tenemos un ID y el API de chrome está disponible.
    if (id && id !== DEFAULT_EXTENSION_ID && typeof chrome !== "undefined" && chrome.runtime) {
      if (!isValidExtensionId(id)) {
        setNotConnected("El ID de la extensión no parece válido (debe tener 32 caracteres a-p).");
        return false;
      }

      return new Promise<boolean>((resolve) => {
        chrome.runtime.sendMessage(id, { type: "PING" }, (response) => {
          if (chrome.runtime.lastError) {
            // Intentar fallback vía window.postMessage si no se encuentra la extensión
            const errorMessage =
              chrome.runtime.lastError?.message ||
              chrome.runtime.lastError?.toString() ||
              "Unknown error";
            console.error(
              "[useExtension] chrome.runtime.sendMessage PING failed",
              {
                extensionId: id,
                error: chrome.runtime.lastError,
                errorMessage,
                serialized: JSON.stringify(chrome.runtime.lastError),
              }
            );
            tryWindowPing().then((ok) => {
              if (!ok) {
                setNotConnected(
                  errorMessage || "Extension not found or not installed"
                );
              }
              resolve(ok);
            });
          } else if (response && response.status === "ok") {
            setState((prev) => ({
              ...prev,
              isConnected: true,
              isLoading: false,
              error: null,
            }));
            resolve(true);
          } else {
            setNotConnected("Invalid response from extension");
            resolve(false);
          }
        });
      });
    }

    // Si no hay chrome.runtime (p.ej. en navegadores que no exponen la API), intentamos el canal window.postMessage.
    const ok = await tryWindowPing();
    if (!ok) {
      setNotConnected("Extension not found or not installed");
    }

    return ok;
  }, [sendWindowMessage, state.extensionId]);

  // Obtener dispositivos de la extension
  const fetchDevices = useCallback(async (): Promise<Device[]> => {
    const id = state.extensionId;

    const setDevicesState = (devices: Device[], lastUpdate?: number) => {
      setState((prev) => ({
        ...prev,
        devices,
        lastUpdate: lastUpdate || Date.now(),
        error: null,
      }));
    };

    try {
      // Intentar el canal de mensajes de chrome (requiere ID de la extensión)
      if (id && id !== DEFAULT_EXTENSION_ID && typeof chrome !== "undefined" && chrome.runtime) {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage(id, { type: "GET_DEVICES" }, (response) => {
            if (chrome.runtime.lastError) {
              const errorMessage =
                chrome.runtime.lastError?.message ||
                chrome.runtime.lastError?.toString() ||
                "Unknown error";
              console.error("[useExtension] chrome.runtime.sendMessage GET_DEVICES failed", {
                extensionId: id,
                error: chrome.runtime.lastError,
                errorMessage,
                serialized: JSON.stringify(chrome.runtime.lastError),
              });
              setState((prev) => ({
                ...prev,
                error: errorMessage || "Failed to fetch devices from extension",
              }));
              resolve([]);
            } else {
              console.log("[useExtension] GET_DEVICES response", response);
              if (response && response.devices) {
                setDevicesState(response.devices, response.lastUpdate);
                resolve(response.devices);
              } else {
                resolve([]);
              }
            }
          });
        });
      }

      // Fallback: usar postMessage al content script inyectado en la misma web.
      const response = await sendWindowMessage({ type: "REQUEST_DEVICES" });
      if (response && response.devices) {
        setDevicesState(response.devices, response.lastUpdate);
        return response.devices;
      }

      return [];
    } catch {
      return [];
    }
  }, [sendWindowMessage, state.extensionId]);

  // Iniciar monitoreo
  const startMonitoring = useCallback(
    async (interval: number = 5000) => {
      const id = state.extensionId;
      if (!id || id === DEFAULT_EXTENSION_ID) {
        // Intentar usar content script inyectado si no hay ID configurado.
        await sendWindowMessage({ type: "START_MONITORING", interval });
        return;
      }

      try {
        if (typeof chrome !== "undefined" && chrome.runtime) {
          chrome.runtime.sendMessage(id, {
            type: "START_MONITORING",
            interval,
          });
          return;
        }

        await sendWindowMessage({ type: "START_MONITORING", interval });
      } catch {
        // Silently fail
      }
    },
    [sendWindowMessage, state.extensionId]
  );

  // Detener monitoreo
  const stopMonitoring = useCallback(async () => {
    const id = state.extensionId;
    if (!id || id === DEFAULT_EXTENSION_ID) {
      await sendWindowMessage({ type: "STOP_MONITORING" });
      return;
    }

    try {
      if (typeof chrome !== "undefined" && chrome.runtime) {
        chrome.runtime.sendMessage(id, { type: "STOP_MONITORING" });
        return;
      }

      await sendWindowMessage({ type: "STOP_MONITORING" });
    } catch {
      // Silently fail
    }
  }, [sendWindowMessage, state.extensionId]);

  // Abrir Find My Device
  const openFindMyDevice = useCallback(
    async (background: boolean = false) => {
      const id = state.extensionId;
      if (!id || id === DEFAULT_EXTENSION_ID) {
        // Intentar usando la extension (via content script) si no hay ID
        await sendWindowMessage({ type: "OPEN_FIND_MY_DEVICE", background });
        window.open("https://www.google.com/android/find", "_blank");
        return;
      }

      try {
        if (typeof chrome !== "undefined" && chrome.runtime) {
          chrome.runtime.sendMessage(id, {
            type: "OPEN_FIND_MY_DEVICE",
            background,
          });
        } else {
          await sendWindowMessage({ type: "OPEN_FIND_MY_DEVICE", background });
          window.open("https://www.google.com/android/find", "_blank");
        }
      } catch {
        window.open("https://www.google.com/android/find", "_blank");
      }
    },
    [sendWindowMessage, state.extensionId]
  );

  // Actualizar extension ID
  const setExtensionId = useCallback((id: string) => {
    const normalized = normalizeExtensionId(id);

    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, normalized);
    }

    setState((prev) => ({
      ...prev,
      extensionId: normalized,
      isLoading: true,
      error: normalized
        ? isValidExtensionId(normalized)
          ? null
          : "El ID de la extensión no parece válido. Asegúrate de pegar solo el ID de 32 caracteres."
        : null,
    }));
  }, []);

  // Efecto para verificar conexion al montar y pedir dispositivos
  useEffect(() => {
    let canceled = false;

    const init = async () => {
      const ok = await checkConnection();
      if (ok && !canceled) {
        await fetchDevices();
      }
    };

    init();

    return () => {
      canceled = true;
    };
  }, [checkConnection, fetchDevices]);

  // Escuchar mensajes de la extension via chrome.runtime (funciona en popups/páginas privilegiadas)
  useEffect(() => {
    const runtime = typeof chrome !== "undefined" ? chrome.runtime : undefined;
    const onMessage = runtime?.onMessage;
    if (!onMessage || !onMessage.addListener) return;

    const handleMessage = (
      message: { type: string; devices?: Device[]; timestamp?: number },
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: any) => void
    ) => {
      if (message.type === "DEVICES_UPDATE" || message.type === "DEVICES_CHANGED") {
        if (message.devices) {
          setState((prev) => ({
            ...prev,
            devices: message.devices!,
            lastUpdate: message.timestamp || Date.now(),
          }));
        }
      }
    };

    onMessage.addListener(handleMessage);

    return () => {
      onMessage.removeListener(handleMessage);
    };
  }, []);

  // Escuchar actualizaciones push del content script via window.postMessage.
  // El content script inyectado en el dashboard reenvía los mensajes DEVICES_UPDATE
  // del background a la página web usando este canal (chrome.runtime no está
  // disponible directamente en páginas web normales).
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handlePushMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== EXTENSION_WINDOW_SOURCE) return;
      // Ignorar mensajes que son respuestas a solicitudes (tienen requestId)
      if (data.requestId) return;

      if (data.type === "DEVICES_UPDATE" || data.type === "DEVICES_CHANGED") {
        if (data.devices) {
          setState((prev) => ({
            ...prev,
            devices: data.devices,
            lastUpdate: data.timestamp || Date.now(),
            isConnected: true,
            isLoading: false,
          }));
        }
      }
    };

    window.addEventListener("message", handlePushMessage);
    return () => window.removeEventListener("message", handlePushMessage);
  }, []); // deps vacío: registrar una vez, la closure usa el setState estable de React

  return {
    ...state,
    checkConnection,
    fetchDevices,
    startMonitoring,
    stopMonitoring,
    openFindMyDevice,
    setExtensionId,
    refresh: fetchDevices,
  };
}

// Hook para datos de demo/prueba

