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
  selectVisualizeFile: () => Promise<{ path: string; text: string } | null>;
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
