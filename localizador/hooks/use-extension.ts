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

export function useExtension(extensionId?: string) {
  const [state, setState] = useState<ExtensionState>({
    isConnected: false,
    isLoading: true,
    error: null,
    devices: [],
    lastUpdate: null,
    extensionId: extensionId || DEFAULT_EXTENSION_ID,
  });

  // Verificar conexion con la extension
  const checkConnection = useCallback(async () => {
    const id = state.extensionId;
    if (!id || id === DEFAULT_EXTENSION_ID) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        isConnected: false,
        error: "Extension ID not configured",
      }));
      return false;
    }

    try {
      // Intentar comunicacion via chrome.runtime.sendMessage
      if (typeof chrome !== "undefined" && chrome.runtime) {
        return new Promise<boolean>((resolve) => {
          chrome.runtime.sendMessage(
            id,
            { type: "PING" },
            (response) => {
              if (chrome.runtime.lastError) {
                setState((prev) => ({
                  ...prev,
                  isConnected: false,
                  isLoading: false,
                  error: "Extension not found or not installed",
                }));
                resolve(false);
              } else if (response && response.status === "ok") {
                setState((prev) => ({
                  ...prev,
                  isConnected: true,
                  isLoading: false,
                  error: null,
                }));
                resolve(true);
              } else {
                setState((prev) => ({
                  ...prev,
                  isConnected: false,
                  isLoading: false,
                  error: "Invalid response from extension",
                }));
                resolve(false);
              }
            }
          );
        });
      } else {
        setState((prev) => ({
          ...prev,
          isConnected: false,
          isLoading: false,
          error: "Chrome extension API not available",
        }));
        return false;
      }
    } catch {
      setState((prev) => ({
        ...prev,
        isConnected: false,
        isLoading: false,
        error: "Failed to connect to extension",
      }));
      return false;
    }
  }, [state.extensionId]);

  // Obtener dispositivos de la extension
  const fetchDevices = useCallback(async (): Promise<Device[]> => {
    const id = state.extensionId;
    if (!id || id === DEFAULT_EXTENSION_ID) {
      return [];
    }

    try {
      if (typeof chrome !== "undefined" && chrome.runtime) {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage(
            id,
            { type: "GET_DEVICES" },
            (response) => {
              if (chrome.runtime.lastError) {
                resolve([]);
              } else if (response && response.devices) {
                setState((prev) => ({
                  ...prev,
                  devices: response.devices,
                  lastUpdate: response.lastUpdate || Date.now(),
                  error: null,
                }));
                resolve(response.devices);
              } else {
                resolve([]);
              }
            }
          );
        });
      }
      return [];
    } catch {
      return [];
    }
  }, [state.extensionId]);

  // Iniciar monitoreo
  const startMonitoring = useCallback(
    async (interval: number = 5000) => {
      const id = state.extensionId;
      if (!id || id === DEFAULT_EXTENSION_ID) return;

      try {
        if (typeof chrome !== "undefined" && chrome.runtime) {
          chrome.runtime.sendMessage(id, {
            type: "START_MONITORING",
            interval,
          });
        }
      } catch {
        // Silently fail
      }
    },
    [state.extensionId]
  );

  // Detener monitoreo
  const stopMonitoring = useCallback(async () => {
    const id = state.extensionId;
    if (!id || id === DEFAULT_EXTENSION_ID) return;

    try {
      if (typeof chrome !== "undefined" && chrome.runtime) {
        chrome.runtime.sendMessage(id, { type: "STOP_MONITORING" });
      }
    } catch {
      // Silently fail
    }
  }, [state.extensionId]);

  // Abrir Find My Device
  const openFindMyDevice = useCallback(
    async (background: boolean = false) => {
      const id = state.extensionId;
      if (!id || id === DEFAULT_EXTENSION_ID) {
        // Abrir directamente
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
          window.open("https://www.google.com/android/find", "_blank");
        }
      } catch {
        window.open("https://www.google.com/android/find", "_blank");
      }
    },
    [state.extensionId]
  );

  // Actualizar extension ID
  const setExtensionId = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      extensionId: id,
      isLoading: true,
    }));
  }, []);

  // Efecto para verificar conexion al montar
  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  // Escuchar mensajes de la extension
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.runtime) return;

    const handleMessage = (message: {
      type: string;
      devices?: Device[];
      timestamp?: number;
    }) => {
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

    chrome.runtime.onMessage.addListener(handleMessage);

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, []);

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
export function useDemoDevices(): Device[] {
  return [
    {
      id: "demo-1",
      name: "Mi Pixel 8 Pro",
      battery: 78,
      lastSeen: new Date().toISOString(),
      location: {
        lat: 40.4168,
        lng: -3.7038,
        address: "Puerta del Sol, Madrid",
      },
      isOnline: true,
      model: "Google Pixel 8 Pro",
      extractedAt: new Date().toISOString(),
    },
    {
      id: "demo-2",
      name: "Samsung Galaxy S24",
      battery: 45,
      lastSeen: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
      location: {
        lat: 40.4530,
        lng: -3.6883,
        address: "Plaza de Castilla, Madrid",
      },
      isOnline: true,
      model: "Samsung Galaxy S24",
      extractedAt: new Date().toISOString(),
    },
    {
      id: "demo-3",
      name: "Tablet Samsung",
      battery: 12,
      lastSeen: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
      location: {
        lat: 40.4200,
        lng: -3.6880,
        address: "Parque del Retiro, Madrid",
      },
      isOnline: false,
      model: "Samsung Galaxy Tab S9",
      extractedAt: new Date().toISOString(),
    },
  ];
}
