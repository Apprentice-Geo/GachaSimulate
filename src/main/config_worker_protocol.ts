import type { CompiledProgram } from "@gachasimulate/config-compiler";
import type { ConfigSource } from "../shared/installed_config";
import type { LocalConfigSnapshot, PackageReceipt } from "./config_snapshot";

export type ConfigWorkerOperations = {
  scan: {
    request: { installed_dir: string; local_dir: string | null };
    response: LocalConfigSnapshot;
  };
  validate: {
    request: { directory: string; id: string; source: ConfigSource };
    response: PackageReceipt;
  };
  verify_install: {
    request: {
      directory: string;
      id: string;
      receipt: PackageReceipt;
      sha256: string;
    };
    response: void;
  };
  compile: {
    request: {
      directory: string;
      id: string;
      source: ConfigSource;
      termination: string;
      result_item: string;
    };
    response: CompiledProgram;
  };
  invalidate: { request: undefined; response: void };
};
export type ConfigWorkerOperation = keyof ConfigWorkerOperations;
export type ConfigWorkerRequest = {
  [K in ConfigWorkerOperation]: {
    id: number;
    operation: K;
    value: ConfigWorkerOperations[K]["request"];
  };
}[ConfigWorkerOperation];
export type ConfigWorkerResponse = { id: number } & (
  | { ok: true; value: unknown }
  | { ok: false; message: string }
);

export interface ConfigWork {
  request<K extends ConfigWorkerOperation>(
    operation: K,
    value: ConfigWorkerOperations[K]["request"],
  ): Promise<ConfigWorkerOperations[K]["response"]>;
  stop(): Promise<void>;
  resume(): void;
}

export const INSTALL_METADATA = ".gachasimulate.json";
