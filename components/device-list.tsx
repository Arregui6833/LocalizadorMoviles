"use client";

import { cn } from "@/lib/utils";
import type { Device } from "@/hooks/use-extension";
import {
  Smartphone,
  Tablet,
  Battery,
  BatteryLow,
  BatteryWarning,
  MapPin,
  Clock,
  Signal,
  SignalZero,
} from "lucide-react";

interface DeviceListProps {
  devices: Device[];
  selectedDevice: string | null;
  onSelectDevice: (id: string) => void;
}

export function DeviceList({
  devices,
  selectedDevice,
  onSelectDevice,
}: DeviceListProps) {
  if (devices.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4">
          <Smartphone className="w-8 h-8 text-muted-foreground" />
        </div>
        <p className="text-muted-foreground text-sm">
          No hay dispositivos detectados
        </p>
        <p className="text-muted-foreground text-xs mt-1">
          Abre Google Find My Device para empezar
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {devices.map((device) => (
        <DeviceCard
          key={device.id}
          device={device}
          isSelected={device.id === selectedDevice}
          onClick={() => onSelectDevice(device.id)}
        />
      ))}
    </div>
  );
}

interface DeviceCardProps {
  device: Device;
  isSelected: boolean;
  onClick: () => void;
}

function DeviceCard({ device, isSelected, onClick }: DeviceCardProps) {
  const isTablet =
    device.model?.toLowerCase().includes("tab") ||
    device.name.toLowerCase().includes("tablet");

  const getBatteryIcon = () => {
    if (!device.battery) return <Battery className="w-4 h-4" />;
    if (device.battery <= 15)
      return <BatteryLow className="w-4 h-4 text-destructive" />;
    if (device.battery <= 30)
      return <BatteryWarning className="w-4 h-4 text-warning" />;
    return <Battery className="w-4 h-4 text-success" />;
  };

  const formatLastSeen = (lastSeen: string | null) => {
    if (!lastSeen) return "Desconocido";

    // Si ya es un texto relativo (ej. "hace 5 minutos"), devolverlo tal cual
    if (/hace|last seen|ultima vez/i.test(lastSeen)) return lastSeen;

    const date = new Date(lastSeen);
    if (isNaN(date.getTime())) return lastSeen; // devolver texto si no es fecha válida

    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "Ahora mismo";
    if (diffMins < 60) return `Hace ${diffMins} min`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `Hace ${diffHours}h`;

    return date.toLocaleDateString("es-ES", {
      day: "numeric",
      month: "short",
    });
  };

  const displayLastSeen = device.activity || formatLastSeen(device.lastSeen);

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full p-4 rounded-lg border text-left transition-all duration-200",
        "hover:border-primary/50 hover:bg-secondary/50",
        isSelected
          ? "border-primary bg-secondary"
          : "border-border bg-card"
      )}
    >
      <div className="flex items-start gap-3">
        {/* Icono del dispositivo */}
        <div
          className={cn(
            "w-10 h-10 rounded-lg flex items-center justify-center shrink-0",
            device.isOnline ? "bg-primary/20" : "bg-muted"
          )}
        >
          {isTablet ? (
            <Tablet
              className={cn(
                "w-5 h-5",
                device.isOnline ? "text-primary" : "text-muted-foreground"
              )}
            />
          ) : (
            <Smartphone
              className={cn(
                "w-5 h-5",
                device.isOnline ? "text-primary" : "text-muted-foreground"
              )}
            />
          )}
        </div>

        {/* Info del dispositivo */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm truncate">{device.name}</h3>
            {device.isOnline ? (
              <Signal className="w-3 h-3 text-success shrink-0" />
            ) : (
              <SignalZero className="w-3 h-3 text-muted-foreground shrink-0" />
            )}
          </div>

          {device.model && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {device.model}
            </p>
          )}

          {/* Metadatos */}
          <div className="flex flex-wrap items-center gap-3 mt-2">
            {device.battery !== null && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                {getBatteryIcon()}
                <span>{device.battery}%</span>
              </div>
            )}

            {device.location?.address && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="w-3 h-3" />
                <span className="truncate max-w-[100px]">
                  {device.location.address}
                </span>
              </div>
            )}

            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              <span>{displayLastSeen}</span>
            </div>
          </div>
        </div>
      </div>
    </button>
  );
}
