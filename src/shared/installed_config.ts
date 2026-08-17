export type InstalledTermination = { file: string; name: string };
export type ConfigItem = { id: string; name: string };
export type ConfigSource = "installed" | "local";
export type InstalledConfig = {
  id: string;
  name: string;
  description: string;
  source: ConfigSource;
  terminations: InstalledTermination[];
  items: ConfigItem[];
};

export type RepositoryConfigStatus =
  | "available"
  | "installed"
  | "update_available"
  | "removed";

export type RepositoryConfig = {
  id: string;
  name: string;
  description: string;
  status: RepositoryConfigStatus;
};

export type ConfigRepositoryState = {
  official: RepositoryConfig[];
  localDirectory: string | null;
  localConfigs: InstalledConfig[];
  sourceError: string | null;
  localError: string | null;
};
export type DesktopApi = {
  listConfigs: () => Promise<InstalledConfig[]>;
  getConfigRepositoryState: () => Promise<ConfigRepositoryState>;
  refreshConfigRepository: () => Promise<ConfigRepositoryState>;
  installConfig: (id: string) => Promise<ConfigRepositoryState>;
  updateConfig: (id: string) => Promise<ConfigRepositoryState>;
  uninstallConfig: (id: string) => Promise<ConfigRepositoryState>;
  selectLocalConfigDirectory: () => Promise<ConfigRepositoryState>;
  getLogicalCpuCount: () => Promise<number>;
  startSimulation: (
    request: import("./simulation").SimulationRequest,
  ) => Promise<void>;
  cancelSimulation: () => Promise<void>;
  selectGsrResult: () => Promise<
    import("./result_editor").ResultEditorState | null
  >;
  saveResultFields: (
    fields: import("./result_editor").DisplayFields,
  ) => Promise<import("./result_editor").ResultEditorState>;
  openResultsDirectory: () => Promise<void>;
  onSimulationEvent: (
    listener: (event: import("./simulation").DesktopSimulationEvent) => void,
  ) => () => void;
};

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}
