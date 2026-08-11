export type InstalledTermination = { file: string; name: string };
export type InstalledConfig = {
  id: string;
  name: string;
  description: string;
  terminations: InstalledTermination[];
};
export type DesktopApi = {
  listInstalledConfigs: () => Promise<InstalledConfig[]>;
  getLogicalCpuCount: () => Promise<number>;
  startSimulation: (
    request: import("./simulation").SimulationRequest,
  ) => Promise<void>;
  cancelSimulation: () => Promise<void>;
  selectGsrResult: () => Promise<
    import("./result_editor").ResultEditorState | null
  >;
  switchResultMetric: (
    metric: import("../visualize/types/visualize_input").VisualizeMetric,
  ) => Promise<import("./result_editor").ResultEditorState>;
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
