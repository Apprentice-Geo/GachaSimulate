import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  compile_yaml,
  read_config_items,
  validate_config_files,
} from "@gachasimulate/config-compiler";
import {
  CONFIG_PACKAGE_FILE_LIMIT,
  CONFIG_PACKAGE_FILE_SIZE_LIMIT,
  validate_config_package,
} from "@gachasimulate/config-repository-contract";
import type { CompiledProgram } from "@gachasimulate/config-compiler";
import type { ConfigSource, InstalledConfig } from "../shared/installed_config";

import { INSTALL_METADATA } from "./config_worker_protocol";
export type InstalledRecord = { config: InstalledConfig; sha256: string };
export type LocalConfigSnapshot = {
  installed: InstalledRecord[];
  local: InstalledRecord[];
  local_error: string | null;
};
export type PackageSnapshot = {
  directory: string;
  id: string;
  source: ConfigSource;
  files: Record<string, string>;
  sizes: Record<string, number>;
  digest: string;
  yaml_digest: string;
};
export type PackageReceipt = { record: InstalledRecord; yaml_digest: string };

function file_text(path: string): { text: string; size: number } {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error(`${basename(path)} must be a regular file`);
  if (entry.size > CONFIG_PACKAGE_FILE_SIZE_LIMIT)
    throw new Error(`${basename(path)} exceeds 1 MiB`);
  const descriptor = openSync(path, "r");
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.ino !== entry.ino ||
      opened.dev !== entry.dev
    )
      throw new Error(`${basename(path)} changed while opening`);
    const contents = readFileSync(descriptor);
    if (contents.length > CONFIG_PACKAGE_FILE_SIZE_LIMIT)
      throw new Error(`${basename(path)} exceeds 1 MiB`);
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(contents),
        size: contents.length,
      };
    } catch {
      throw new Error(`${basename(path)} must be valid UTF-8`);
    }
  } finally {
    closeSync(descriptor);
  }
}

export function read_package_snapshot(
  directory: string,
  id: string,
  source: ConfigSource,
): PackageSnapshot {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("configuration must be a directory");
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (
    entries.length >
    CONFIG_PACKAGE_FILE_LIMIT + (source === "installed" ? 1 : 0)
  )
    throw new Error("configuration package contains more than 64 files");
  const files: Record<string, string> = {};
  const sizes: Record<string, number> = {};
  const digest = createHash("sha256");
  const yaml_digest = createHash("sha256");
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      (!entry.name.endsWith(".yaml") &&
        !(source === "installed" && entry.name === INSTALL_METADATA))
    )
      throw new Error(`unexpected configuration entry: ${entry.name}`);
    const value = file_text(join(directory, entry.name));
    files[entry.name] = value.text;
    sizes[entry.name] = value.size;
    const framed = `${entry.name}\0${value.size}\0${value.text}\0`;
    digest.update(framed);
    if (entry.name.endsWith(".yaml")) yaml_digest.update(framed);
  }
  const after = readdirSync(directory).sort((a, b) => a.localeCompare(b));
  if (
    after.length !== entries.length ||
    after.some((name, index) => name !== entries[index].name)
  )
    throw new Error("configuration file set changed while reading");
  return {
    directory: resolve(directory),
    id,
    source,
    files,
    sizes,
    digest: digest.digest("hex"),
    yaml_digest: yaml_digest.digest("hex"),
  };
}

function metadata_sha(snapshot: PackageSnapshot): string {
  if (snapshot.source === "local") return "";
  const raw: unknown = JSON.parse(snapshot.files[INSTALL_METADATA] ?? "null");
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("invalid installed configuration metadata");
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).length !== 1 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  )
    throw new Error("invalid installed configuration metadata");
  return value.sha256;
}

export function validate_package_snapshot(
  snapshot: PackageSnapshot,
): InstalledRecord {
  const manifest = validate_config_package(
    snapshot.id,
    snapshot.files["manifest.yaml"],
    Object.keys(snapshot.files)
      .filter((name) => name.endsWith(".yaml"))
      .map((path) => ({ path, size: snapshot.sizes[path] })),
  );
  const sha256 = metadata_sha(snapshot);
  const config_text = snapshot.files["config.yaml"];
  const failed = validate_config_files(
    config_text,
    manifest.terminations.map(({ file }) => ({
      file,
      text: snapshot.files[file],
    })),
  );
  if (failed.length)
    throw new Error(`configuration validation failed: ${failed.join(", ")}`);
  return {
    config: {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      source: snapshot.source,
      terminations: manifest.terminations,
      items: read_config_items(config_text),
    },
    sha256,
  };
}

export function validate_config_directory(
  directory: string,
  id: string,
  source: ConfigSource,
): InstalledRecord {
  return validate_package_snapshot(
    read_package_snapshot(directory, id, source),
  );
}

/** Worker-local cache: each query rereads all bytes and replaces the prior roots. */
export class ConfigSnapshotEngine {
  private cache = new Map<
    string,
    { digest: string; record: InstalledRecord }
  >();
  private receipt: PackageReceipt | null = null;
  constructor(private readonly validate = validate_package_snapshot) {}

  scan(
    installed_dir: string | null,
    local_dir: string | null,
  ): LocalConfigSnapshot {
    const next = new Map<string, { digest: string; record: InstalledRecord }>();
    const read_root = (
      root: string,
      source: ConfigSource,
    ): InstalledRecord[] => {
      if (!existsSync(root)) {
        if (source === "local")
          throw new Error("所选本地配置目录已不存在，请重新选择。");
        return [];
      }
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("configuration root must be a directory");
      const records: InstalledRecord[] = [];
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        try {
          if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new Error("configuration entry must be a directory");
          const snapshot = read_package_snapshot(
            join(root, entry.name),
            entry.name,
            source,
          );
          const key = `${source}\0${snapshot.directory}`;
          const old = this.cache.get(key);
          const receipt = this.receipt;
          const record =
            old?.digest === snapshot.digest
              ? old.record
              : receipt?.record.config.id === snapshot.id &&
                  receipt.yaml_digest === snapshot.yaml_digest
                ? {
                    config: { ...receipt.record.config, source },
                    sha256: metadata_sha(snapshot),
                  }
                : this.validate(snapshot);
          next.set(key, { digest: snapshot.digest, record });
          records.push(record);
        } catch (error) {
          console.warn(
            `Skipping invalid ${source} config ${entry.name}:`,
            error,
          );
        }
      }
      return records.sort((a, b) => a.config.id.localeCompare(b.config.id));
    };
    const installed = installed_dir
      ? read_root(installed_dir, "installed")
      : [];
    let local: InstalledRecord[] = [];
    let local_error: string | null = null;
    if (local_dir) {
      try {
        local = read_root(local_dir, "local");
      } catch (error) {
        local_error = error instanceof Error ? error.message : String(error);
      }
    }
    this.cache = next;
    return { installed, local, local_error };
  }

  invalidate(): void {
    this.cache.clear();
    this.receipt = null;
  }

  validate_directory(
    directory: string,
    id: string,
    source: ConfigSource,
  ): PackageReceipt {
    const snapshot = read_package_snapshot(directory, id, source);
    const receipt = {
      record: this.validate(snapshot),
      yaml_digest: snapshot.yaml_digest,
    };
    this.receipt = receipt;
    return receipt;
  }

  verify_install(
    directory: string,
    id: string,
    receipt: PackageReceipt,
    expected_sha: string,
  ): void {
    const snapshot = read_package_snapshot(directory, id, "installed");
    if (
      snapshot.yaml_digest !== receipt.yaml_digest ||
      metadata_sha(snapshot) !== expected_sha
    )
      throw new Error("configuration changed after package validation");
  }

  compile(
    directory: string,
    id: string,
    source: ConfigSource,
    termination: string,
    result_item: string,
  ): CompiledProgram {
    const snapshot = read_package_snapshot(directory, id, source);
    const { config } = this.validate(snapshot);
    if (!config.terminations.some(({ file }) => file === termination))
      throw new Error("termination is not declared by the selected config");
    return compile_yaml(
      snapshot.files["config.yaml"],
      snapshot.files[termination],
      snapshot.files["manifest.yaml"],
      result_item,
    );
  }
}

export function scan_installed_configs(root: string): InstalledConfig[] {
  return new ConfigSnapshotEngine()
    .scan(root, null)
    .installed.map(({ config }) => config);
}
export function scan_local_configs(root: string | null): InstalledConfig[] {
  return root
    ? new ConfigSnapshotEngine()
        .scan(null, root)
        .local.map(({ config }) => config)
    : [];
}
export function resolve_config_selection(
  installed_dir: string,
  local_dir: string | null,
  source: ConfigSource,
  id: string,
  termination: string,
): string {
  const root = source === "installed" ? installed_dir : local_dir;
  if (!root)
    throw new Error(`${source} configuration directory is unavailable`);
  const directory = join(root, id);
  if (
    !validate_config_directory(directory, id, source).config.terminations.some(
      ({ file }) => file === termination,
    )
  )
    throw new Error("termination is not declared by the selected config");
  return directory;
}
