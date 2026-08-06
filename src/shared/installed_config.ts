export type InstalledTermination = { file: string; name: string };
export type InstalledConfig = {
  id: string;
  name: string;
  description: string;
  terminations: InstalledTermination[];
};
export type DesktopApi = {
  listInstalledConfigs: () => Promise<InstalledConfig[]>;
  startSimulation: (request: import("./simulation").SimulationRequest) => Promise<void>;
  cancelSimulation: () => Promise<void>;
  onSimulationEvent: (
    listener: (event: import("./simulation").DesktopSimulationEvent) => void,
  ) => () => void;
};

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}
