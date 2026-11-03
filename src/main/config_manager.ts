import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, win32 } from "node:path";
import type { CompiledProgram } from "@gachasimulate/config-compiler";
import type { SimulationRequest } from "../shared/simulation";
import type { LocalConfigSnapshot } from "./config_snapshot";
import type { ConfigWork } from "./config_worker_protocol";
import { ConfigWorkerClient } from "./config_worker_client";
import {
  CONFIG_PACKAGE_FILE_LIMIT,
  CONFIG_PACKAGE_FILE_SIZE_LIMIT,
  read_repository_index,
  type ConfigRepositoryIndex,
} from "@gachasimulate/config-repository-contract";
import * as yauzl from "yauzl";
import type {
  ConfigRepositoryState,
  InstalledConfig,
  RepositoryConfig,
} from "../shared/installed_config";
import {
  CONFIG_INDEX_DOWNLOAD_LIMIT,
  CONFIG_ZIP_DOWNLOAD_LIMIT,
  OFFICIAL_CONFIG_INDEX_URL,
} from "./config_download";

import { INSTALL_METADATA } from "./config_worker_protocol";
import { settle_shutdown } from "./shutdown";
import {
  NATIVE_PROCESS_TIMEOUT_MS,
  wait_for_process_close,
} from "./native_process";
const SETTINGS_FILE = "local-config.json";
const CONFIG_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONFIG_REFRESH_TTL_MS = 5 * 60 * 1_000;

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
  config_work?: ConfigWork;
  shutdown_timeout_ms?: number;
  assert_request_allowed?: (
    kind: "config-change" | "config-refresh" | "simulation",
  ) => void;
};

export class ConfigManager {
  private remote: ConfigRepositoryIndex | null = null;
  private remote_error: string | null = null;
  private local_directory: string | null = null;
  private changing = false;
  private suspended = false;
  private generation = 0;
  private change_in_flight: Promise<ConfigRepositoryState> | null = null;
  private readonly config_work: ConfigWork;
  private refreshed_at: number | null = null;
  private refresh_in_flight: Promise<ConfigRepositoryState> | null = null;
  readonly installed_dir: string;
  private readonly staging_dir: string;
  private readonly settings_path: string;

  constructor(
    private readonly configs_dir: string,
    private readonly dependencies: ConfigManagerDependencies,
  ) {
    this.config_work = dependencies.config_work ?? new ConfigWorkerClient();
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

  private assert_available(expected_generation?: number): void {
    if (this.suspended)
      throw new Error("configuration work is stopped during shutdown");
    if (
      expected_generation !== undefined &&
      expected_generation !== this.generation
    )
      throw new Error("configuration directory has changed");
  }

  private invalidate_snapshot(): void {
    this.generation += 1;
  }

  private async local_snapshot(): Promise<LocalConfigSnapshot> {
    this.assert_available();
    const generation = this.generation;
    const snapshot = await this.config_work.request("scan", {
      installed_dir: this.installed_dir,
      local_dir: this.local_directory,
    });
    this.assert_available();
    if (generation !== this.generation) return this.local_snapshot();
    return snapshot;
  }

  async list_configs(): Promise<InstalledConfig[]> {
    const snapshot = await this.local_snapshot();
    return [...snapshot.installed, ...snapshot.local]
      .map(({ config }) => config)
      .sort(
        (a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
      );
  }

  async state(): Promise<ConfigRepositoryState> {
    const snapshot = await this.local_snapshot();
    const installed = snapshot.installed;
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

    return {
      official,
      localDirectory: this.local_directory,
      localConfigs: snapshot.local.map(({ config }) => config),
      sourceError: this.remote_error,
      localError: snapshot.local_error,
    };
  }

  async refresh(force = false): Promise<ConfigRepositoryState> {
    this.assert_available();
    this.dependencies.assert_request_allowed?.("config-refresh");
    if (this.changing)
      throw new Error("a configuration change is already running");
    if (this.refresh_in_flight) return this.refresh_in_flight;
    if (force) this.invalidate_snapshot();
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
    const generation = this.generation;
    try {
      const body = await this.dependencies.download(
        OFFICIAL_CONFIG_INDEX_URL,
        CONFIG_INDEX_DOWNLOAD_LIMIT,
      );
      this.assert_available(generation);
      this.dependencies.assert_request_allowed?.("config-refresh");
      this.remote = read_repository_index(body.toString("utf8"));
      this.remote_error = null;
    } catch (error) {
      this.assert_available(generation);
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
    return this.change(async (generation) => {
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
        this.assert_available(generation);
        this.dependencies.assert_request_allowed?.("config-change");
        const digest = createHash("sha256").update(archive).digest("hex");
        if (digest !== entry.sha256)
          throw new Error(
            "configuration package SHA-256 does not match the index",
          );
        await extract_zip(archive, staged_config);
        this.assert_available(generation);
        const receipt = await this.config_work.request("validate", {
          directory: staged_config,
          id,
          source: "local",
        });
        this.assert_available(generation);
        this.dependencies.assert_request_allowed?.("config-change");
        writeFileSync(
          join(staged_config, INSTALL_METADATA),
          JSON.stringify({ sha256: entry.sha256 }),
          { flag: "wx" },
        );
        await this.config_work.request("verify_install", {
          directory: staged_config,
          id,
          receipt,
          sha256: entry.sha256,
        });
        this.assert_available(generation);
        this.dependencies.assert_request_allowed?.("config-change");
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
    operation: (generation: number) => Promise<void>,
  ): Promise<ConfigRepositoryState> {
    this.assert_available();
    this.dependencies.assert_request_allowed?.("config-change");
    if (this.changing)
      throw new Error("a configuration change is already running");
    if (this.dependencies.simulation_active())
      throw new Error(
        "configuration changes are unavailable during simulation",
      );
    this.changing = true;
    const generation = this.generation;
    const running = (async () => {
      try {
        await operation(generation);
        this.assert_available(generation);
      } finally {
        this.changing = false;
        this.invalidate_snapshot();
      }
      return this.state();
    })();
    this.change_in_flight = running;
    try {
      return await running;
    } finally {
      if (this.change_in_flight === running) this.change_in_flight = null;
    }
  }

  async compile_selection(
    request: SimulationRequest,
  ): Promise<CompiledProgram> {
    this.assert_available();
    const generation = this.generation;
    const root =
      request.configSource === "installed"
        ? this.installed_dir
        : this.local_directory;
    if (!root)
      throw new Error(
        `${request.configSource} configuration directory is unavailable`,
      );
    const program = await this.config_work.request("compile", {
      directory: join(root, request.configId),
      id: request.configId,
      source: request.configSource,
      termination: request.termination,
      result_item: request.resultItem,
    });
    this.assert_available(generation);
    this.dependencies.assert_request_allowed?.("simulation");
    return program;
  }

  async shutdown(): Promise<void> {
    this.suspended = true;
    this.generation += 1;
    const changing = this.change_in_flight;
    const refreshing = this.refresh_in_flight;
    const timeout =
      this.dependencies.shutdown_timeout_ms ?? NATIVE_PROCESS_TIMEOUT_MS;
    await settle_shutdown([
      () => this.config_work.stop(),
      async () => {
        if (changing)
          await wait_for_process_close(
            changing.catch(() => undefined),
            timeout,
            "configuration change settlement timed out",
          );
      },
      async () => {
        if (refreshing)
          await wait_for_process_close(
            refreshing.catch(() => undefined),
            timeout,
            "configuration refresh settlement timed out",
          );
      },
    ]);
  }

  resume(): void {
    this.config_work.resume();
    this.suspended = false;
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
