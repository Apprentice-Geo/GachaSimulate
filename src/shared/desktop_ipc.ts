import type { AppLink } from "./app_info";
import type {
  InstalledConfig,
  ConfigRepositoryState,
} from "./installed_config";
import type { SimulationRequest, DesktopSimulationEvent } from "./simulation";
import type {
  ResultEditorState,
  SaveResultFieldsRequest,
  SavedResultFields,
} from "./result_editor";
import type {
  ExportPreparationRequest,
  ExportPreparationAccepted,
  ExportDestinationRequest,
  ExportDestinationSelection,
  ExportOverwriteConfirmation,
  ExportCancelRequest,
  ExportTaskRequest,
  DesktopExportEvent,
} from "./export_task";

export type DesktopRequests = {
  "open-app-link": { args: [link: AppLink]; result: void };
  "list-configs": { args: []; result: InstalledConfig[] };
  "get-config-repository-state": { args: []; result: ConfigRepositoryState };
  "refresh-config-repository": {
    args: [force?: boolean];
    result: ConfigRepositoryState;
  };
  "install-config": { args: [id: string]; result: ConfigRepositoryState };
  "update-config": { args: [id: string]; result: ConfigRepositoryState };
  "uninstall-config": { args: [id: string]; result: ConfigRepositoryState };
  "select-local-config-directory": { args: []; result: ConfigRepositoryState };
  "get-logical-cpu-count": { args: []; result: number };
  "start-simulation": { args: [request: SimulationRequest]; result: void };
  "cancel-simulation": { args: []; result: void };
  "select-gsr-result": { args: []; result: ResultEditorState | null };
  "save-result-fields": {
    args: [request: SaveResultFieldsRequest];
    result: SavedResultFields;
  };
  "prepare-export": {
    args: [request: ExportPreparationRequest];
    result: ExportPreparationAccepted;
  };
  "select-export-destination": {
    args: [request: ExportDestinationRequest];
    result: ExportDestinationSelection;
  };
  "confirm-export-overwrite": {
    args: [request: ExportDestinationRequest];
    result: ExportOverwriteConfirmation;
  };
  "cancel-export": { args: [request: ExportCancelRequest]; result: void };
  "retry-export-cleanup": { args: [request: ExportTaskRequest]; result: void };
  "open-export-directory": { args: [request: ExportTaskRequest]; result: void };
  "exit-after-export-cleanup": {
    args: [request: ExportTaskRequest];
    result: void;
  };
  "open-results-directory": { args: []; result: void };
};

export type DesktopChannel = keyof DesktopRequests;
export type DesktopArgs<C extends DesktopChannel> = DesktopRequests[C]["args"];
export type DesktopResponse<C extends DesktopChannel> =
  DesktopRequests[C]["result"];
export type DesktopInvoke<C extends DesktopChannel> = (
  ...args: DesktopArgs<C>
) => Promise<DesktopResponse<C>>;
export type DesktopEvents = {
  "simulation-event": DesktopSimulationEvent;
  "export-event": DesktopExportEvent;
};
export type DesktopEventChannel = keyof DesktopEvents;

export type DesktopApi = {
  openAppLink: DesktopInvoke<"open-app-link">;
  listConfigs: DesktopInvoke<"list-configs">;
  getConfigRepositoryState: DesktopInvoke<"get-config-repository-state">;
  refreshConfigRepository: DesktopInvoke<"refresh-config-repository">;
  installConfig: DesktopInvoke<"install-config">;
  updateConfig: DesktopInvoke<"update-config">;
  uninstallConfig: DesktopInvoke<"uninstall-config">;
  selectLocalConfigDirectory: DesktopInvoke<"select-local-config-directory">;
  getLogicalCpuCount: DesktopInvoke<"get-logical-cpu-count">;
  startSimulation: DesktopInvoke<"start-simulation">;
  cancelSimulation: DesktopInvoke<"cancel-simulation">;
  selectGsrResult: DesktopInvoke<"select-gsr-result">;
  saveResultFields: DesktopInvoke<"save-result-fields">;
  prepareExport: DesktopInvoke<"prepare-export">;
  selectExportDestination: DesktopInvoke<"select-export-destination">;
  confirmExportOverwrite: DesktopInvoke<"confirm-export-overwrite">;
  cancelExport: DesktopInvoke<"cancel-export">;
  retryExportCleanup: DesktopInvoke<"retry-export-cleanup">;
  openExportDirectory: DesktopInvoke<"open-export-directory">;
  exitAfterExportCleanup: DesktopInvoke<"exit-after-export-cleanup">;
  openResultsDirectory: DesktopInvoke<"open-results-directory">;
  onSimulationEvent: (
    listener: (event: DesktopEvents["simulation-event"]) => void,
  ) => () => void;
  onExportEvent: (
    listener: (event: DesktopEvents["export-event"]) => void,
  ) => () => void;
};

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}
