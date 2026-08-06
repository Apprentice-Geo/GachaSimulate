export type InstalledTermination = { file: string; name: string };
export type InstalledConfig = {
  id: string;
  name: string;
  description: string;
  terminations: InstalledTermination[];
};
export type DesktopApi = {
  listInstalledConfigs: () => Promise<InstalledConfig[]>;
};

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}
