import { contextBridge } from "electron";
import type { DesktopApi } from "../shared/desktop_ipc";
import { invoke_desktop, subscribe_desktop } from "./desktop_ipc";

const desktop_api = {
  openAppLink: (link) => invoke_desktop("open-app-link", link),
  listConfigs: () => invoke_desktop("list-configs"),
  getConfigRepositoryState: () => invoke_desktop("get-config-repository-state"),
  refreshConfigRepository: (force = false) =>
    invoke_desktop("refresh-config-repository", force),
  installConfig: (id) => invoke_desktop("install-config", id),
  updateConfig: (id) => invoke_desktop("update-config", id),
  uninstallConfig: (id) => invoke_desktop("uninstall-config", id),
  selectLocalConfigDirectory: () =>
    invoke_desktop("select-local-config-directory"),
  getLogicalCpuCount: () => invoke_desktop("get-logical-cpu-count"),
  startSimulation: (request) => invoke_desktop("start-simulation", request),
  cancelSimulation: () => invoke_desktop("cancel-simulation"),
  selectGsrResult: () => invoke_desktop("select-gsr-result"),
  saveResultFields: (request) => invoke_desktop("save-result-fields", request),
  prepareExport: (request) => invoke_desktop("prepare-export", request),
  selectExportDestination: (request) =>
    invoke_desktop("select-export-destination", request),
  confirmExportOverwrite: (request) =>
    invoke_desktop("confirm-export-overwrite", request),
  cancelExport: (request) => invoke_desktop("cancel-export", request),
  retryExportCleanup: (request) =>
    invoke_desktop("retry-export-cleanup", request),
  openExportDirectory: (request) =>
    invoke_desktop("open-export-directory", request),
  exitAfterExportCleanup: (request) =>
    invoke_desktop("exit-after-export-cleanup", request),
  openResultsDirectory: () => invoke_desktop("open-results-directory"),
  onSimulationEvent: (listener) =>
    subscribe_desktop("simulation-event", listener),
  onExportEvent: (listener) => subscribe_desktop("export-event", listener),
} satisfies DesktopApi;

contextBridge.exposeInMainWorld("desktopApi", desktop_api);
