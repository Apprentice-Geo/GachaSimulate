import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopSimulationEvent,
  SimulationRequest,
} from "../shared/simulation";

contextBridge.exposeInMainWorld("desktopApi", {
  listConfigs: () => ipcRenderer.invoke("list-configs"),
  getConfigRepositoryState: () =>
    ipcRenderer.invoke("get-config-repository-state"),
  refreshConfigRepository: () =>
    ipcRenderer.invoke("refresh-config-repository"),
  installConfig: (id: string) => ipcRenderer.invoke("install-config", id),
  updateConfig: (id: string) => ipcRenderer.invoke("update-config", id),
  uninstallConfig: (id: string) => ipcRenderer.invoke("uninstall-config", id),
  selectLocalConfigDirectory: () =>
    ipcRenderer.invoke("select-local-config-directory"),
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
