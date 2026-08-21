export type ActionRange = { begin: number; count: number };
export type CompiledProgram = { ir: Record<string, unknown> };
export type ConfigItem = { id: string; name: string };
export type ConfigTermination = { file: string; name: string };
export type ConfigManifest = {
  id: string;
  name: string;
  description: string;
  terminations: ConfigTermination[];
  metadata?: unknown;
};

export type TerminationYaml = {
  file: string;
  text: string;
};
