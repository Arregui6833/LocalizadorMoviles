"use client";

import { useState, useEffect } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

export function Dashboard() {
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [useDemoMode, setUseDemoMode] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

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

  const selectedDeviceData = devices.find((d) => d.id === selectedDevice);

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

        {/* Main Content */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Device List */}
          <div className="lg:col-span-1">
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
                />
              </div>
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
                    <p className="text-muted-foreground">Ubicación</p>
                    <p className="mt-1 truncate">
                      {selectedDeviceData.location?.address
                        ? selectedDeviceData.location.address
                        : selectedDeviceData.location?.lat && selectedDeviceData.location?.lng
                        ? `${selectedDeviceData.location.lat.toFixed(4)}, ${selectedDeviceData.location.lng.toFixed(4)}`
                        : "Sin ubicación"}
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
