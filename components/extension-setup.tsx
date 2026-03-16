"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Download,
  ExternalLink,
  CheckCircle,
  AlertCircle,
  Copy,
  Check,
} from "lucide-react";

interface ExtensionSetupProps {
  extensionId: string;
  isConnected: boolean;
  error: string | null;
  onSetExtensionId: (id: string) => void;
  onOpenFindMyDevice: () => void;
}

export function ExtensionSetup({
  extensionId,
  isConnected,
  error,
  onSetExtensionId,
  onOpenFindMyDevice,
}: ExtensionSetupProps) {
  const [inputId, setInputId] = useState(extensionId || "");
  const [copied, setCopied] = useState(false);

  // Sincronizar el campo de texto cuando cambie el ID (por ejemplo, al cargar desde localStorage)
  useEffect(() => {
    setInputId(extensionId || "");
  }, [extensionId]);

  const handleSave = () => {
    onSetExtensionId(inputId);
  };

  const copyId = async () => {
    await navigator.clipboard.writeText(inputId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-start gap-4">
        <div
          className={`w-12 h-12 rounded-lg flex items-center justify-center ${
            isConnected ? "bg-success/20" : "bg-warning/20"
          }`}
        >
          {isConnected ? (
            <CheckCircle className="w-6 h-6 text-success" />
          ) : (
            <AlertCircle className="w-6 h-6 text-warning" />
          )}
        </div>

        <div className="flex-1">
          <h2 className="font-semibold text-lg">
            {isConnected ? "Extension Conectada" : "Configurar Extension"}
          </h2>
          <p className="text-muted-foreground text-sm mt-1">
            {isConnected
              ? "La extension esta funcionando correctamente"
              : "Sigue estos pasos para conectar la extension"}
          </p>
        </div>
      </div>

      {!isConnected && (
        <div className="mt-6 space-y-6">
          {/* Paso 1: Descargar extension */}
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-semibold text-sm shrink-0">
              1
            </div>
            <div className="flex-1">
              <h3 className="font-medium">Descargar la extension</h3>
              <p className="text-muted-foreground text-sm mt-1">
                Abre la carpeta <code className="px-1 py-0.5 rounded bg-secondary">extension/</code> en este proyecto y cárgala como extensión descomprimida.
              </p>
            </div>
          </div>

          {/* Paso 2: Instalar extension */}
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-semibold text-sm shrink-0">
              2
            </div>
            <div className="flex-1">
              <h3 className="font-medium">Instalar en Chrome</h3>
              <p className="text-muted-foreground text-sm mt-1">
                Abre <code className="px-1 py-0.5 rounded bg-secondary">chrome://extensions</code>, 
                activa el modo desarrollador y carga la extension descomprimida
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => window.open("chrome://extensions", "_blank")}
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Abrir Extensiones
              </Button>
            </div>
          </div>

          {/* Paso 3: Copiar ID */}
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-semibold text-sm shrink-0">
              3
            </div>
            <div className="flex-1">
              <h3 className="font-medium">ID de la extensión (opcional)</h3>
              <p className="text-muted-foreground text-sm mt-1">
                Si lo deseas, copia el ID de la extensión (desde <code className="px-1 py-0.5 rounded bg-secondary">chrome://extensions</code>) y pégalo aquí.
                Si no lo haces, seguirá intentando comunicarse con la extensión vía el content script inyectado.
              </p>
              <div className="flex gap-2 mt-3">
                <Input
                  value={inputId}
                  onChange={(e) => setInputId(e.target.value)}
                  placeholder="abcdefghijklmnopqrstuvwxyz..."
                  className="font-mono text-sm"
                />
                <Button variant="outline" size="icon" onClick={copyId}>
                  {copied ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
                <Button onClick={handleSave}>Guardar</Button>
              </div>
            </div>
          </div>

          {/* Paso 4: Abrir Find My Device */}
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-semibold text-sm shrink-0">
              4
            </div>
            <div className="flex-1">
              <h3 className="font-medium">Abrir Google Find My Device</h3>
              <p className="text-muted-foreground text-sm mt-1">
                Inicia sesion en Find My Device para que la extension pueda
                leer tus dispositivos
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => onOpenFindMyDevice()}
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Abrir Find My Device
              </Button>
            </div>
          </div>

          {error && (
            <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20">
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}
        </div>
      )}

      {isConnected && (
        <div className="mt-4 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenFindMyDevice()}
          >
            <ExternalLink className="w-4 h-4 mr-2" />
            Abrir Find My Device
          </Button>
        </div>
      )}
    </div>
  );
}
