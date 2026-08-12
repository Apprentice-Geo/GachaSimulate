import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopSimulationEvent,
  SimulationRequest,
} from "../shared/simulation";

contextBridge.exposeInMainWorld("desktopApi", {
  listInstalledConfigs: () => ipcRenderer.invoke("list-installed-configs"),
  getLogicalCpuCount: () => ipcRenderer.invoke("get-logical-cpu-count"),
  startSimulation: (request: SimulationRequest) =>
    ipcRenderer.invoke("start-simulation", request),
  cancelSimulation: () => ipcRenderer.invoke("cancel-simulation"),
  selectGsrResult: () => ipcRenderer.invoke("select-gsr-result"),
  saveResultFields: (fields: import("../shared/result_editor").DisplayFields) =>
    ipcRenderer.invoke("save-result-fields", fields),
  openResultsDirectory: () => ipcRenderer.invoke("open-results-directory"),
  onSimulationEvent: (listener: (event: DesktopSimulationEvent) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      value: DesktopSimulationEvent,
    ) => listener(value);
    ipcRenderer.on("simulation-event", handler);
    return () => ipcRenderer.removeListener("simulation-event", handler);
  },
});
