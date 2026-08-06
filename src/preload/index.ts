import { contextBridge, ipcRenderer } from "electron";
import type { DesktopSimulationEvent, SimulationRequest } from "../shared/simulation";

contextBridge.exposeInMainWorld("desktopApi", {
  listInstalledConfigs: () => ipcRenderer.invoke("list-installed-configs"),
  startSimulation: (request: SimulationRequest) => ipcRenderer.invoke("start-simulation", request),
  cancelSimulation: () => ipcRenderer.invoke("cancel-simulation"),
  onSimulationEvent: (listener: (event: DesktopSimulationEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: DesktopSimulationEvent) => listener(value);
    ipcRenderer.on("simulation-event", handler);
    return () => ipcRenderer.removeListener("simulation-event", handler);
  },
});
