import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  read_config_items,
  read_config_manifest,
} from "@gachasimulate/config-compiler";
import type { InstalledConfig } from "../shared/installed_config";

function read_manifest(path: string, directory_name: string): InstalledConfig {
  const manifest = read_config_manifest(readFileSync(path, "utf8"));
  if (manifest.id !== directory_name) throw new Error("manifest id mismatch");
  const root = resolve(path, "..");
  const terminations = manifest.terminations.map((termination) => {
    const file_path = resolve(root, termination.file);
    if (relative(root, file_path).startsWith("..") || !existsSync(file_path))
      throw new Error("invalid termination path");
    if (isAbsolute(termination.file))
      throw new Error("invalid termination path");
    return termination;
  });
  const config_path = join(root, "config.yaml");
  if (!existsSync(config_path)) throw new Error("config.yaml is missing");
  const items = read_config_items(readFileSync(config_path, "utf8"));
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    terminations,
    items,
  };
}

export function scan_installed_configs(
  installed_dir: string,
): InstalledConfig[] {
  if (!existsSync(installed_dir)) return [];
  const configs: InstalledConfig[] = [];
  for (const directory_name of readdirSync(installed_dir)) {
    try {
      configs.push(
        read_manifest(
          join(installed_dir, directory_name, "manifest.yaml"),
          directory_name,
        ),
      );
    } catch (error) {
      console.warn(
        `Skipping invalid installed config ${directory_name}:`,
        error,
      );
    }
  }
  return configs.sort((left, right) => left.id.localeCompare(right.id));
}

export function validate_installed_config_selection(
  installed_dir: string,
  config_id: string,
  termination: string,
): void {
  const config = scan_installed_configs(installed_dir).find(
    (installed) => installed.id === config_id,
  );
  if (!config) throw new Error("installed config not found");
  if (!config.terminations.some((item) => item.file === termination))
    throw new Error("termination is not declared by the installed config");
}

export function initialize_installed_configs(
  installed_dir: string,
  presets_dir: string,
): void {
  mkdirSync(installed_dir, { recursive: true });
  if (readdirSync(installed_dir).length > 0) return;
  for (const entry of readdirSync(presets_dir, { withFileTypes: true })) {
    if (entry.isDirectory())
      cpSync(join(presets_dir, entry.name), join(installed_dir, entry.name), {
        recursive: true,
      });
  }
}
