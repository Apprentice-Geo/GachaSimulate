import type { ProgramIR } from "./ir.js";

export type { ActionRange } from "./ir.js";
export type CompiledProgram = { ir: ProgramIR };
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
