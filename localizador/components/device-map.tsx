"use client";

import { useEffect, useRef } from "react";
import type { Device } from "@/hooks/use-extension";

interface DeviceMapProps {
  devices: Device[];
  selectedDevice: string | null;
  onSelectDevice: (id: string) => void;
}

export function DeviceMap({
  devices,
  selectedDevice,
  onSelectDevice,
}: DeviceMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());

  useEffect(() => {
    // Cargar Leaflet dinamicamente
    const loadLeaflet = async () => {
      if (typeof window === "undefined") return;

      // Cargar CSS
      if (!document.querySelector('link[href*="leaflet.css"]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(link);
      }

      // Cargar JS
      if (!window.L) {
        await new Promise<void>((resolve) => {
          const script = document.createElement("script");
          script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
          script.onload = () => resolve();
          document.head.appendChild(script);
        });
      }

      // Inicializar mapa
      if (mapRef.current && !mapInstanceRef.current && window.L) {
        const L = window.L;
        
        // Centro por defecto (Madrid)
        const defaultCenter: [number, number] = [40.4168, -3.7038];
        
        mapInstanceRef.current = L.map(mapRef.current, {
          center: defaultCenter,
          zoom: 12,
          zoomControl: true,
        });

        // Usar tiles oscuros
        L.tileLayer(
          "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
          {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            maxZoom: 19,
          }
        ).addTo(mapInstanceRef.current);
      }
    };

    loadLeaflet();

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  // Actualizar marcadores cuando cambien los dispositivos
  useEffect(() => {
    if (!mapInstanceRef.current || !window.L) return;

    const L = window.L;
    const map = mapInstanceRef.current;
    const bounds: [number, number][] = [];

    // Limpiar marcadores antiguos
    markersRef.current.forEach((marker) => {
      marker.remove();
    });
    markersRef.current.clear();

    // Crear nuevos marcadores
    devices.forEach((device) => {
      if (device.location?.lat && device.location?.lng) {
        const isSelected = device.id === selectedDevice;
        const isOnline = device.isOnline;

        // Icono personalizado
        const iconHtml = `
          <div style="
            width: ${isSelected ? "40px" : "32px"};
            height: ${isSelected ? "40px" : "32px"};
            background: ${isOnline ? "#22d3ee" : "#6b7280"};
            border: 3px solid ${isSelected ? "#ffffff" : "transparent"};
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            transition: all 0.2s ease;
          ">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" stroke-width="2.5">
              <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
              <line x1="12" y1="18" x2="12" y2="18"/>
            </svg>
          </div>
        `;

        const icon = L.divIcon({
          html: iconHtml,
          className: "device-marker",
          iconSize: [isSelected ? 40 : 32, isSelected ? 40 : 32],
          iconAnchor: [isSelected ? 20 : 16, isSelected ? 20 : 16],
        });

        const marker = L.marker([device.location.lat, device.location.lng], {
          icon,
        }).addTo(map);

        // Popup
        marker.bindPopup(`
          <div style="padding: 8px; min-width: 150px;">
            <strong style="font-size: 14px;">${device.name}</strong>
            ${device.battery ? `<br><span style="color: #a3a3a3;">Bateria: ${device.battery}%</span>` : ""}
            ${device.location.address ? `<br><span style="color: #a3a3a3; font-size: 12px;">${device.location.address}</span>` : ""}
          </div>
        `);

        // Click handler
        marker.on("click", () => {
          onSelectDevice(device.id);
        });

        markersRef.current.set(device.id, marker);
        bounds.push([device.location.lat, device.location.lng]);
      }
    });

    // Ajustar vista si hay dispositivos
    if (bounds.length > 0) {
      if (bounds.length === 1) {
        map.setView(bounds[0], 15);
      } else {
        map.fitBounds(bounds, { padding: [50, 50] });
      }
    }
  }, [devices, selectedDevice, onSelectDevice]);

  // Centrar en dispositivo seleccionado
  useEffect(() => {
    if (!mapInstanceRef.current || !selectedDevice) return;

    const device = devices.find((d) => d.id === selectedDevice);
    if (device?.location?.lat && device?.location?.lng) {
      mapInstanceRef.current.setView(
        [device.location.lat, device.location.lng],
        16,
        { animate: true }
      );

      // Abrir popup del marcador
      const marker = markersRef.current.get(selectedDevice);
      if (marker) {
        marker.openPopup();
      }
    }
  }, [selectedDevice, devices]);

  return (
    <div
      ref={mapRef}
      className="w-full h-full min-h-[400px] rounded-lg overflow-hidden"
      style={{ background: "var(--card)" }}
    />
  );
}

// Declaracion de tipos para Leaflet
declare global {
  interface Window {
    L: typeof import("leaflet");
  }
}
