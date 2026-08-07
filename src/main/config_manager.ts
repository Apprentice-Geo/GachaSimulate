import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import type { InstalledConfig } from "../shared/installed_config";

const ID_RE = /^[A-Za-z0-9_-]+$/;

function read_manifest(path: string, directory_name: string): InstalledConfig {
  const manifest = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (
    !manifest ||
    typeof manifest.id !== "string" ||
    manifest.id !== directory_name ||
    !ID_RE.test(manifest.id) ||
    typeof manifest.name !== "string" ||
    !manifest.name.trim() ||
    typeof manifest.description !== "string" ||
    !Array.isArray(manifest.terminations) ||
    manifest.terminations.length === 0
  )
    throw new Error("invalid manifest fields");
  const root = resolve(path, "..");
  const terminations = manifest.terminations.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      throw new Error("invalid termination");
    const value = entry as Record<string, unknown>;
    if (
      typeof value.file !== "string" ||
      isAbsolute(value.file) ||
      value.file.includes("\\") ||
      value.file.includes("/") ||
      typeof value.name !== "string" ||
      !value.name.trim()
    )
      throw new Error("invalid termination");
    const file_path = resolve(root, value.file);
    if (relative(root, file_path).startsWith("..") || !existsSync(file_path))
      throw new Error("invalid termination path");
    return { file: value.file, name: value.name };
  });
  if (!existsSync(join(root, "config.yaml")))
    throw new Error("config.yaml is missing");
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    terminations,
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
