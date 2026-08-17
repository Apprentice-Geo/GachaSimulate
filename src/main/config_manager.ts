import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute, join, win32 } from "node:path";
import {
  read_config_items,
  validate_config_files,
} from "@gachasimulate/config-compiler";
import {
  CONFIG_PACKAGE_FILE_LIMIT,
  CONFIG_PACKAGE_FILE_SIZE_LIMIT,
  read_repository_index,
  validate_config_package,
  type ConfigRepositoryIndex,
} from "@gachasimulate/config-repository-contract";
import * as yauzl from "yauzl";
import type {
  ConfigRepositoryState,
  ConfigSource,
  InstalledConfig,
  RepositoryConfig,
} from "../shared/installed_config";
import {
  CONFIG_INDEX_DOWNLOAD_LIMIT,
  CONFIG_ZIP_DOWNLOAD_LIMIT,
  OFFICIAL_CONFIG_INDEX_URL,
} from "./config_download";

const INSTALL_METADATA = ".gachasimulate.json";
const SETTINGS_FILE = "local-config.json";
const SHA256 = /^[0-9a-f]{64}$/;
const CONFIG_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONFIG_REFRESH_TTL_MS = 5 * 60 * 1_000;

type InstalledRecord = { config: InstalledConfig; sha256: string };

function file_text(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${basename(path)} must be a regular file`);
  if (stat.size > CONFIG_PACKAGE_FILE_SIZE_LIMIT)
    throw new Error(`${basename(path)} exceeds 1 MiB`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    throw new Error(`${basename(path)} must be valid UTF-8`);
  }
}

function install_metadata(path: string): string {
  const raw: unknown = JSON.parse(file_text(path));
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("invalid installed configuration metadata");
  const metadata = raw as Record<string, unknown>;
  if (
    Object.keys(metadata).length !== 1 ||
    typeof metadata.sha256 !== "string" ||
    !SHA256.test(metadata.sha256)
  )
    throw new Error("invalid installed configuration metadata");
  return metadata.sha256;
}

export function validate_config_directory(
  directory: string,
  directory_id: string,
  source: ConfigSource,
): InstalledRecord {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("configuration must be a directory");
  const entries = readdirSync(directory, { withFileTypes: true });
  const allowed_private = source === "installed" ? INSTALL_METADATA : null;
  for (const entry of entries)
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      (entry.name !== allowed_private && !entry.name.endsWith(".yaml"))
    )
      throw new Error(`unexpected configuration entry: ${entry.name}`);

  const yaml_entries = entries.filter(({ name }) => name.endsWith(".yaml"));
  const manifest_text = file_text(join(directory, "manifest.yaml"));
  const manifest = validate_config_package(
    directory_id,
    manifest_text,
    yaml_entries.map(({ name }) => ({
      path: name,
      size: lstatSync(join(directory, name)).size,
    })),
  );
  const config_text = file_text(join(directory, "config.yaml"));
  const terminations = manifest.terminations.map(({ file }) => ({
    file,
    text: file_text(join(directory, file)),
  }));
  const failed = validate_config_files(config_text, terminations);
  if (failed.length)
    throw new Error(`configuration validation failed: ${failed.join(", ")}`);
  return {
    config: {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      source,
      terminations: manifest.terminations,
      items: read_config_items(config_text),
    },
    sha256:
      source === "installed"
        ? install_metadata(join(directory, INSTALL_METADATA))
        : "",
  };
}

function scan_records(root: string, source: ConfigSource): InstalledRecord[] {
  if (!existsSync(root)) return [];
  const configs: InstalledRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("configuration entry must be a directory");
      configs.push(
        validate_config_directory(join(root, entry.name), entry.name, source),
      );
    } catch (error) {
      console.warn(`Skipping invalid ${source} config ${entry.name}:`, error);
    }
  }
  return configs.sort((left, right) =>
    left.config.id.localeCompare(right.config.id),
  );
}

export function scan_installed_configs(
  installed_dir: string,
): InstalledConfig[] {
  return scan_records(installed_dir, "installed").map(({ config }) => config);
}

export function scan_local_configs(
  local_dir: string | null,
): InstalledConfig[] {
  return local_dir
    ? scan_records(local_dir, "local").map(({ config }) => config)
    : [];
}

export function resolve_config_selection(
  installed_dir: string,
  local_dir: string | null,
  source: ConfigSource,
  config_id: string,
  termination: string,
): string {
  const root = source === "installed" ? installed_dir : local_dir;
  if (!root)
    throw new Error(`${source} configuration directory is unavailable`);
  const directory = join(root, config_id);
  const { config } = validate_config_directory(directory, config_id, source);
  if (!config.terminations.some(({ file }) => file === termination))
    throw new Error("termination is not declared by the selected config");
  return directory;
}

async function extract_zip(buffer: Buffer, destination: string): Promise<void> {
  const zip = await yauzl.fromBufferPromise(buffer, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  if (zip.entryCount > CONFIG_PACKAGE_FILE_LIMIT) {
    zip.close();
    throw new Error("configuration ZIP contains more than 64 entries");
  }
  const names = new Set<string>();
  const folded = new Set<string>();
  mkdirSync(destination, { recursive: true });
  try {
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (
        !name ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\") ||
        name.includes("\0") ||
        isAbsolute(name) ||
        win32.isAbsolute(name) ||
        /^[A-Za-z]:/.test(name)
      )
        throw new Error(`unsafe configuration ZIP path: ${name}`);
      if (names.has(name) || folded.has(name.toLowerCase()))
        throw new Error(`duplicate configuration ZIP path: ${name}`);
      names.add(name);
      folded.add(name.toLowerCase());

      const platform = entry.versionMadeBy >>> 8;
      const file_type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (
        name.endsWith("/") ||
        (platform === 3 && file_type !== 0 && file_type !== 0o100000)
      )
        throw new Error(
          `configuration ZIP entry is not a regular file: ${name}`,
        );
      if (entry.uncompressedSize > CONFIG_PACKAGE_FILE_SIZE_LIMIT)
        throw new Error(`${name} exceeds 1 MiB`);

      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const raw of stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        size += chunk.length;
        if (size > CONFIG_PACKAGE_FILE_SIZE_LIMIT) {
          stream.destroy();
          throw new Error(`${name} exceeds 1 MiB`);
        }
        chunks.push(chunk);
      }
      writeFileSync(join(destination, name), Buffer.concat(chunks, size), {
        flag: "wx",
      });
    }
  } finally {
    zip.close();
  }
}

type ConfigManagerDependencies = {
  download: (url: string, limit: number) => Promise<Buffer>;
  simulation_active: () => boolean;
  now?: () => number;
  random_uuid?: () => string;
  rename?: typeof renameSync;
};

export class ConfigManager {
  private remote: ConfigRepositoryIndex | null = null;
  private remote_error: string | null = null;
  private local_directory: string | null = null;
  private changing = false;
  private refreshed_at: number | null = null;
  private refresh_in_flight: Promise<ConfigRepositoryState> | null = null;
  readonly installed_dir: string;
  private readonly staging_dir: string;
  private readonly settings_path: string;

  constructor(
    private readonly configs_dir: string,
    private readonly dependencies: ConfigManagerDependencies,
  ) {
    this.installed_dir = join(configs_dir, "installed");
    this.staging_dir = join(configs_dir, ".staging");
    this.settings_path = join(configs_dir, SETTINGS_FILE);
    mkdirSync(this.installed_dir, { recursive: true });
    rmSync(this.staging_dir, { recursive: true, force: true });
    this.local_directory = this.read_local_directory();
  }

  get active(): boolean {
    return this.changing;
  }

  get local_dir(): string | null {
    return this.local_directory;
  }

  list_configs(): InstalledConfig[] {
    return [
      ...scan_installed_configs(this.installed_dir),
      ...scan_local_configs(this.local_directory),
    ].sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.id.localeCompare(right.id),
    );
  }

  state(): ConfigRepositoryState {
    const installed = scan_records(this.installed_dir, "installed");
    const installed_by_id = new Map(
      installed.map((record) => [record.config.id, record]),
    );
    const official: RepositoryConfig[] = [];
    for (const entry of this.remote?.configs ?? []) {
      const local = installed_by_id.get(entry.id);
      official.push({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        status: !local
          ? "available"
          : local.sha256 === entry.sha256
            ? "installed"
            : "update_available",
      });
      installed_by_id.delete(entry.id);
    }
    for (const { config } of installed_by_id.values())
      official.push({
        id: config.id,
        name: config.name,
        description: config.description,
        status: this.remote ? "removed" : "installed",
      });
    official.sort((left, right) => left.id.localeCompare(right.id));

    let local_error: string | null = null;
    let local_configs: InstalledConfig[] = [];
    if (this.local_directory) {
      try {
        if (!existsSync(this.local_directory))
          throw new Error("所选本地配置目录已不存在，请重新选择。");
        local_configs = scan_local_configs(this.local_directory);
      } catch (error) {
        local_error = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      official,
      localDirectory: this.local_directory,
      localConfigs: local_configs,
      sourceError: this.remote_error,
      localError: local_error,
    };
  }

  async refresh(force = false): Promise<ConfigRepositoryState> {
    if (this.changing)
      throw new Error("a configuration change is already running");
    if (this.refresh_in_flight) return this.refresh_in_flight;
    const now = this.dependencies.now ?? Date.now;
    if (
      !force &&
      this.refreshed_at !== null &&
      now() - this.refreshed_at < CONFIG_REFRESH_TTL_MS
    )
      return this.state();

    const refresh = this.refresh_remote();
    this.refresh_in_flight = refresh;
    try {
      return await refresh;
    } finally {
      this.refreshed_at = now();
      this.refresh_in_flight = null;
    }
  }

  private async refresh_remote(): Promise<ConfigRepositoryState> {
    try {
      const body = await this.dependencies.download(
        OFFICIAL_CONFIG_INDEX_URL,
        CONFIG_INDEX_DOWNLOAD_LIMIT,
      );
      this.remote = read_repository_index(body.toString("utf8"));
      this.remote_error = null;
    } catch (error) {
      this.remote_error =
        error instanceof Error ? error.message : String(error);
    }
    return this.state();
  }

  install(id: string): Promise<ConfigRepositoryState> {
    return this.install_or_update(id);
  }

  update(id: string): Promise<ConfigRepositoryState> {
    return this.install_or_update(id);
  }

  async uninstall(id: string): Promise<ConfigRepositoryState> {
    return this.change(async () => {
      this.assert_id(id);
      rmSync(join(this.installed_dir, id), { recursive: true, force: true });
    });
  }

  async set_local_directory(directory: string): Promise<ConfigRepositoryState> {
    return this.change(async () => {
      const root = lstatSync(directory);
      if (!root.isDirectory() || root.isSymbolicLink())
        throw new Error("local configuration path must be a directory");
      mkdirSync(this.configs_dir, { recursive: true });
      const temporary = `${this.settings_path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(
          temporary,
          JSON.stringify({ localDirectory: directory }),
          {
            flag: "wx",
          },
        );
        renameSync(temporary, this.settings_path);
      } finally {
        rmSync(temporary, { force: true });
      }
      this.local_directory = directory;
    });
  }

  private async install_or_update(id: string): Promise<ConfigRepositoryState> {
    return this.change(async () => {
      this.assert_id(id);
      const entry = this.remote?.configs.find((config) => config.id === id);
      if (!entry)
        throw new Error("configuration is not present in the official source");
      const task_dir = join(
        this.staging_dir,
        (this.dependencies.random_uuid ?? randomUUID)(),
      );
      const staged_config = join(task_dir, id);
      try {
        const url = new URL(entry.download_url, OFFICIAL_CONFIG_INDEX_URL);
        const archive = await this.dependencies.download(
          url.href,
          CONFIG_ZIP_DOWNLOAD_LIMIT,
        );
        const digest = createHash("sha256").update(archive).digest("hex");
        if (digest !== entry.sha256)
          throw new Error(
            "configuration package SHA-256 does not match the index",
          );
        await extract_zip(archive, staged_config);
        validate_config_directory(staged_config, id, "local");
        writeFileSync(
          join(staged_config, INSTALL_METADATA),
          JSON.stringify({ sha256: entry.sha256 }),
          { flag: "wx" },
        );
        validate_config_directory(staged_config, id, "installed");
        this.commit(staged_config, join(this.installed_dir, id), task_dir);
      } finally {
        rmSync(task_dir, { recursive: true, force: true });
      }
    });
  }

  private commit(staged: string, destination: string, task_dir: string): void {
    const rename = this.dependencies.rename ?? renameSync;
    const previous = join(task_dir, ".previous");
    const had_previous = existsSync(destination);
    if (had_previous) rename(destination, previous);
    try {
      rename(staged, destination);
    } catch (error) {
      if (had_previous && existsSync(previous)) rename(previous, destination);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
  }

  private async change(
    operation: () => Promise<void>,
  ): Promise<ConfigRepositoryState> {
    if (this.changing)
      throw new Error("a configuration change is already running");
    if (this.dependencies.simulation_active())
      throw new Error(
        "configuration changes are unavailable during simulation",
      );
    this.changing = true;
    try {
      await operation();
    } finally {
      this.changing = false;
    }
    return this.state();
  }

  private assert_id(id: string): void {
    if (!CONFIG_ID.test(id)) throw new Error("invalid configuration id");
  }

  private read_local_directory(): string | null {
    if (!existsSync(this.settings_path)) return null;
    try {
      const value: unknown = JSON.parse(
        readFileSync(this.settings_path, "utf8"),
      );
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid local configuration settings");
      const settings = value as Record<string, unknown>;
      if (
        Object.keys(settings).length !== 1 ||
        typeof settings.localDirectory !== "string" ||
        !settings.localDirectory
      )
        throw new Error("invalid local configuration settings");
      return settings.localDirectory;
    } catch (error) {
      console.warn("Ignoring invalid local configuration settings:", error);
      return null;
    }
  }
}
