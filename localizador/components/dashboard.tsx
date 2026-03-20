"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { DeviceMap } from "@/components/device-map";
import { DeviceList } from "@/components/device-list";
import { ExtensionSetup } from "@/components/extension-setup";
import { useExtension, useDemoDevices } from "@/hooks/use-extension";
import {
  RefreshCw,
  Settings,
  Maximize2,
  Play,
  Pause,
  MapPin,
  Smartphone,
  Battery,
  Clock,
  User,
  Eye,
  AlertTriangle,
  Navigation,
  Bell,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Returns the distance in metres between two lat/lng points (Haversine formula). */
function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type MonitorMode = "movement" | "approaching" | null;

export function Dashboard() {
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [useDemoMode, setUseDemoMode] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Role assignment
  const [myDeviceId, setMyDeviceId] = useState<string | null>(null);
  const [watchedDeviceId, setWatchedDeviceId] = useState<string | null>(null);

  // Proximity monitoring
  const [monitorMode, setMonitorMode] = useState<MonitorMode>(null);
  const [monitorActive, setMonitorActive] = useState(false);
  const [monitorAlert, setMonitorAlert] = useState<string | null>(null);

  const prevWatchedPos = useRef<{ lat: number; lng: number } | null>(null);
  const prevDistanceRef = useRef<number | null>(null);

  const {
    isConnected,
    isLoading,
    error,
    devices: realDevices,
    extensionId,
    setExtensionId,
    fetchDevices,
    startMonitoring,
    stopMonitoring,
    openFindMyDevice,
  } = useExtension();

  const demoDevices = useDemoDevices();
  const devices = useDemoMode ? demoDevices : realDevices;

  // Auto-refresh en modo demo
  useEffect(() => {
    if (useDemoMode) {
      setLastRefresh(new Date());
    }
  }, [useDemoMode]);

  // Cambiar automáticamente al modo real cuando la extensión envía dispositivos reales
  useEffect(() => {
    if (realDevices.length > 0 && useDemoMode) {
      setUseDemoMode(false);
      setLastRefresh(new Date());
    }
  }, [realDevices.length, useDemoMode]);

  // Actualizar lastRefresh cuando lleguen nuevos datos reales vía push
  useEffect(() => {
    if (!useDemoMode && realDevices.length > 0) {
      setLastRefresh(new Date());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realDevices]);

  // Monitor loop: check positions when monitorActive is true
  useEffect(() => {
    if (!monitorActive || !monitorMode || !watchedDeviceId) return;

    const watched = devices.find((d) => d.id === watchedDeviceId);
    const watchedLat = watched?.location?.lat;
    const watchedLng = watched?.location?.lng;
    if (watchedLat == null || watchedLng == null) return;

    if (monitorMode === "movement") {
      const prev = prevWatchedPos.current;
      if (prev != null) {
        const dist = haversineMeters(prev.lat, prev.lng, watchedLat, watchedLng);
        if (dist > 50) {
          setMonitorAlert(
            `⚠ ${watched!.name} se ha movido ${Math.round(dist)} m desde la última comprobación.`
          );
          prevWatchedPos.current = { lat: watchedLat, lng: watchedLng };
        }
      } else {
        prevWatchedPos.current = { lat: watchedLat, lng: watchedLng };
      }
    } else if (monitorMode === "approaching") {
      const myDevice = devices.find((d) => d.id === myDeviceId);
      const myLat = myDevice?.location?.lat;
      const myLng = myDevice?.location?.lng;
      if (myLat == null || myLng == null) return;

      const dist = haversineMeters(myLat, myLng, watchedLat, watchedLng);
      const prevDist = prevDistanceRef.current;
      if (prevDist != null && dist < prevDist && dist < 500) {
        setMonitorAlert(
          `⚠ ${watched!.name} se está acercando a tu dispositivo (${Math.round(dist)} m).`
        );
      }
      prevDistanceRef.current = dist;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, monitorActive, monitorMode, watchedDeviceId, myDeviceId]);

  const handleRefresh = async () => {
    if (!useDemoMode) {
      await fetchDevices();
    }
    setLastRefresh(new Date());
  };

  const handleToggleMonitoring = () => {
    if (isMonitoring) {
      stopMonitoring();
    } else {
      startMonitoring(5000);
    }
    setIsMonitoring(!isMonitoring);
  };

  const handleStartMonitor = () => {
    if (!monitorMode) return;
    prevWatchedPos.current = null;
    prevDistanceRef.current = null;
    setMonitorAlert(null);
    setMonitorActive(true);
  };

  const handleStopMonitor = () => {
    setMonitorActive(false);
    prevWatchedPos.current = null;
    prevDistanceRef.current = null;
  };

  const selectedDeviceData = devices.find((d) => d.id === selectedDevice);
  const myDeviceData = devices.find((d) => d.id === myDeviceId);
  const watchedDeviceData = devices.find((d) => d.id === watchedDeviceId);

  const canStartMonitor =
    monitorMode != null &&
    watchedDeviceId != null &&
    (monitorMode === "movement" || (monitorMode === "approaching" && myDeviceId != null));

  // Estadisticas
  const stats = {
    total: devices.length,
    online: devices.filter((d) => d.isOnline).length,
    lowBattery: devices.filter((d) => d.battery !== null && d.battery < 20).length,
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
                <MapPin className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h1 className="font-semibold text-lg">Device Tracker</h1>
                <p className="text-muted-foreground text-xs">
                  {useDemoMode ? "Modo Demo" : isConnected ? "Conectado" : "Desconectado"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Toggle Demo/Real */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setUseDemoMode(!useDemoMode)}
              >
                {useDemoMode ? "Usar Extension" : "Modo Demo"}
              </Button>

              {!useDemoMode && (
                <>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleToggleMonitoring}
                    disabled={!isConnected}
                  >
                    {isMonitoring ? (
                      <Pause className="w-4 h-4" />
                    ) : (
                      <Play className="w-4 h-4" />
                    )}
                  </Button>

                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleRefresh}
                    disabled={isLoading}
                  >
                    <RefreshCw
                      className={cn("w-4 h-4", isLoading && "animate-spin")}
                    />
                  </Button>
                </>
              )}

              <Button
                variant="outline"
                size="icon"
                onClick={() => setShowSettings(!showSettings)}
              >
                <Settings className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        {/* Settings Panel */}
        {showSettings && !useDemoMode && (
          <div className="mb-6">
            <ExtensionSetup
              extensionId={extensionId || ""}
              isConnected={isConnected}
              error={error}
              onSetExtensionId={setExtensionId}
              onOpenFindMyDevice={openFindMyDevice}
            />
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="p-4 rounded-lg border border-border bg-card">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
                <Smartphone className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{stats.total}</p>
                <p className="text-muted-foreground text-xs">Dispositivos</p>
              </div>
            </div>
          </div>

          <div className="p-4 rounded-lg border border-border bg-card">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-success/20 flex items-center justify-center">
                <div className="w-3 h-3 rounded-full bg-success" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{stats.online}</p>
                <p className="text-muted-foreground text-xs">En linea</p>
              </div>
            </div>
          </div>

          <div className="p-4 rounded-lg border border-border bg-card">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-destructive/20 flex items-center justify-center">
                <Battery className="w-5 h-5 text-destructive" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{stats.lowBattery}</p>
                <p className="text-muted-foreground text-xs">Bateria baja</p>
              </div>
            </div>
          </div>
        </div>

        {/* Monitoring Alert */}
        {monitorAlert && (
          <div className="mb-4 p-3 rounded-lg border border-orange-500/50 bg-orange-500/10 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-orange-400">
              <Bell className="w-4 h-4 shrink-0" />
              <span>{monitorAlert}</span>
            </div>
            <button
              onClick={() => setMonitorAlert(null)}
              className="text-orange-400/60 hover:text-orange-400 text-xs shrink-0"
            >
              ✕
            </button>
          </div>
        )}

        {/* Main Content */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Device List + Monitoring Panel */}
          <div className="lg:col-span-1 flex flex-col gap-4">
            <div className="rounded-lg border border-border bg-card">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <h2 className="font-medium">Dispositivos</h2>
                {lastRefresh && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {lastRefresh.toLocaleTimeString("es-ES", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                )}
              </div>
              <div className="p-4">
                <DeviceList
                  devices={devices}
                  selectedDevice={selectedDevice}
                  onSelectDevice={setSelectedDevice}
                  myDeviceId={myDeviceId}
                  watchedDeviceId={watchedDeviceId}
                  onSetMyDevice={(id) => setMyDeviceId(id === myDeviceId ? null : id)}
                  onSetWatchedDevice={(id) => setWatchedDeviceId(id === watchedDeviceId ? null : id)}
                />
              </div>
            </div>

            {/* Monitoring Panel */}
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="font-medium mb-3 flex items-center gap-2">
                <Navigation className="w-4 h-4 text-primary" />
                Vigilancia
              </h2>

              {/* Role summary */}
              <div className="flex flex-col gap-1 mb-4 text-xs">
                <div className="flex items-center gap-2">
                  <User className="w-3 h-3 text-blue-400" />
                  <span className="text-muted-foreground">Mi dispositivo:</span>
                  <span className={cn(myDeviceData ? "text-blue-400" : "text-muted-foreground/50")}>
                    {myDeviceData?.name ?? "Sin seleccionar"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Eye className="w-3 h-3 text-orange-400" />
                  <span className="text-muted-foreground">Dispositivo vigilado:</span>
                  <span className={cn(watchedDeviceData ? "text-orange-400" : "text-muted-foreground/50")}>
                    {watchedDeviceData?.name ?? "Sin seleccionar"}
                  </span>
                </div>
              </div>

              {/* Mode selector */}
              <div className="flex flex-col gap-2 mb-4">
                <button
                  onClick={() => setMonitorMode(monitorMode === "movement" ? null : "movement")}
                  className={cn(
                    "flex items-start gap-3 p-3 rounded-lg border text-left text-sm transition-colors",
                    monitorMode === "movement"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:border-primary/50 text-muted-foreground"
                  )}
                >
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-foreground">Modo 1 — Movimiento</p>
                    <p className="text-xs mt-0.5">
                      Alerta si el dispositivo vigilado se mueve más de 50 m de su posición anterior.
                    </p>
                  </div>
                </button>

                <button
                  onClick={() => setMonitorMode(monitorMode === "approaching" ? null : "approaching")}
                  className={cn(
                    "flex items-start gap-3 p-3 rounded-lg border text-left text-sm transition-colors",
                    monitorMode === "approaching"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:border-primary/50 text-muted-foreground"
                  )}
                >
                  <Navigation className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-foreground">Modo 2 — Acercamiento</p>
                    <p className="text-xs mt-0.5">
                      Alerta si el dispositivo vigilado se está acercando a tu dispositivo.
                    </p>
                  </div>
                </button>
              </div>

              {/* Start / Stop button */}
              {monitorActive ? (
                <Button
                  variant="destructive"
                  size="sm"
                  className="w-full"
                  onClick={handleStopMonitor}
                >
                  <Pause className="w-4 h-4 mr-2" />
                  Detener vigilancia
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="w-full"
                  disabled={!canStartMonitor}
                  onClick={handleStartMonitor}
                  title={
                    !canStartMonitor
                      ? "Selecciona un modo y un dispositivo vigilado (y tu dispositivo para el modo 2)"
                      : undefined
                  }
                >
                  <Play className="w-4 h-4 mr-2" />
                  Iniciar vigilancia
                </Button>
              )}

              {monitorActive && (
                <p className="text-xs text-success text-center mt-2">
                  Vigilancia activa — {monitorMode === "movement" ? "Modo movimiento" : "Modo acercamiento"}
                </p>
              )}
            </div>
          </div>

          {/* Map */}
          <div className="lg:col-span-2">
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <h2 className="font-medium">Mapa</h2>
                <Button variant="ghost" size="icon">
                  <Maximize2 className="w-4 h-4" />
                </Button>
              </div>
              <div className="h-[500px]">
                <DeviceMap
                  devices={devices}
                  selectedDevice={selectedDevice}
                  onSelectDevice={setSelectedDevice}
                />
              </div>
            </div>

            {/* Selected Device Details */}
            {selectedDeviceData && (
              <div className="mt-4 p-4 rounded-lg border border-border bg-card">
                <h3 className="font-medium mb-3">
                  {selectedDeviceData.name}
                </h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Estado</p>
                    <p className="flex items-center gap-2 mt-1">
                      <span
                        className={cn(
                          "w-2 h-2 rounded-full",
                          selectedDeviceData.isOnline
                            ? "bg-success"
                            : "bg-muted-foreground"
                        )}
                      />
                      {selectedDeviceData.isOnline ? "En linea" : "Desconectado"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Bateria</p>
                    <p className="mt-1">
                      {selectedDeviceData.battery !== null
                        ? `${selectedDeviceData.battery}%`
                        : "Desconocida"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Ubicacion</p>
                    <p className="mt-1 truncate">
                      {selectedDeviceData.location?.address
                        ? selectedDeviceData.location.address
                        : selectedDeviceData.location?.lat && selectedDeviceData.location?.lng
                        ? `${selectedDeviceData.location.lat.toFixed(4)}, ${selectedDeviceData.location.lng.toFixed(4)}`
                        : "Sin ubicacion"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Actividad</p>
                    <p className="mt-1 truncate">
                      {selectedDeviceData.activity || selectedDeviceData.lastSeen || "Desconocida"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Coordenadas</p>
                    <p className="mt-1 font-mono text-xs">
                      {selectedDeviceData.location?.lat &&
                      selectedDeviceData.location?.lng
                        ? `${selectedDeviceData.location.lat.toFixed(4)}, ${selectedDeviceData.location.lng.toFixed(4)}`
                        : "N/A"}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

