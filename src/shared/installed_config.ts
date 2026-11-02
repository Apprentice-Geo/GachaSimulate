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
