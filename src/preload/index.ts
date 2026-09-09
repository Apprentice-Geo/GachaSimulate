import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopSimulationEvent,
  SimulationRequest,
} from "../shared/simulation";

contextBridge.exposeInMainWorld("desktopApi", {
  listConfigs: () => ipcRenderer.invoke("list-configs"),
  getConfigRepositoryState: () =>
    ipcRenderer.invoke("get-config-repository-state"),
  refreshConfigRepository: (force = false) =>
    ipcRenderer.invoke("refresh-config-repository", force),
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
  saveResultFields: (
    request: import("../shared/result_editor").SaveResultFieldsRequest,
  ) => ipcRenderer.invoke("save-result-fields", request),
  prepareExport: (
    request: import("../shared/export_task").ExportPreparationRequest,
  ) => ipcRenderer.invoke("prepare-export", request),
  selectExportDestination: (
    request: import("../shared/export_task").ExportDestinationRequest,
  ) => ipcRenderer.invoke("select-export-destination", request),
  confirmExportOverwrite: (
    request: import("../shared/export_task").ExportDestinationRequest,
  ) => ipcRenderer.invoke("confirm-export-overwrite", request),
  cancelExport: (
    request: import("../shared/export_task").ExportCancelRequest,
  ) => ipcRenderer.invoke("cancel-export", request),
  retryExportCleanup: (
    request: import("../shared/export_task").ExportTaskRequest,
  ) => ipcRenderer.invoke("retry-export-cleanup", request),
  openExportDirectory: (
    request: import("../shared/export_task").ExportTaskRequest,
  ) => ipcRenderer.invoke("open-export-directory", request),
  exitAfterExportCleanup: (
    request: import("../shared/export_task").ExportTaskRequest,
  ) => ipcRenderer.invoke("exit-after-export-cleanup", request),
  openResultsDirectory: () => ipcRenderer.invoke("open-results-directory"),
  onSimulationEvent: (listener: (event: DesktopSimulationEvent) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      value: DesktopSimulationEvent,
    ) => listener(value);
    ipcRenderer.on("simulation-event", handler);
    return () => ipcRenderer.removeListener("simulation-event", handler);
  },
  onExportEvent: (
    listener: (
      event: import("../shared/export_task").DesktopExportEvent,
    ) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      value: import("../shared/export_task").DesktopExportEvent,
    ) => listener(value);
    ipcRenderer.on("export-event", handler);
    return () => ipcRenderer.removeListener("export-event", handler);
  },
});
