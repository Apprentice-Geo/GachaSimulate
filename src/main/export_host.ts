import { spawn as node_spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as node_files from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import type { BrowserWindowConstructorOptions, IpcMainEvent } from "electron";
import {
  EXPORT_RENDERER_CHANNELS,
  is_export_failed_message,
  is_export_frame_message,
  is_export_initialized_message,
} from "../shared/export_renderer";
import { EXPORT_FRAME_COUNT } from "../visualize/animation/export_frame";
import { ANIMATION_COMPLETION_FRAME } from "../visualize/animation/timeline";
import { CANVAS_HEIGHT, CANVAS_WIDTH, VIDEO_FPS } from "../visualize/constants";
import type { CDFViewModel } from "../visualize/types/cdf";
import type { ExportFormat, ExportStage } from "../shared/export_task";

export { EXPORT_FRAME_COUNT };

export const EXPORT_WIDTH = CANVAS_WIDTH;
export const EXPORT_HEIGHT = CANVAS_HEIGHT;
export const EXPORT_FPS = VIDEO_FPS;
export const EXPORT_PNG_FRAME = ANIMATION_COMPLETION_FRAME;
export const EXPORT_STDERR_LIMIT = 64 * 1024;

export interface ExportHostRequest {
  readonly job_id: string;
  readonly formats: readonly ExportFormat[];
  readonly view_model: CDFViewModel;
  readonly destinations: Readonly<Partial<Record<ExportFormat, string>>>;
  readonly target_identities: Readonly<
    Partial<Record<ExportFormat, TargetIdentity>>
  >;
  readonly on_progress?: (progress: ExportHostProgress) => void;
}

export interface ExportHostProgress {
  readonly stage: ExportStage;
  readonly completed?: number;
  readonly total?: number;
  readonly png_written?: boolean;
  readonly format?: ExportFormat;
  readonly committed?: number;
  readonly artifact_total?: number;
}

interface OutputState {
  readonly format: ExportFormat;
  readonly destination: string;
  partial: string;
  backup: string;
  committed: boolean;
}

interface ExportDebugger {
  attach(protocol_version?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, parameters?: object): Promise<unknown>;
}

interface ExportWebContents {
  readonly debugger: ExportDebugger;
  isDestroyed(): boolean;
  send(channel: string, message: unknown): void;
  setBackgroundThrottling(allowed: boolean): void;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  setZoomFactor(factor: number): void;
  on(event: string, listener: (...args: never[]) => void): this;
  off(event: string, listener: (...args: never[]) => void): this;
}

interface ExportWindow {
  readonly webContents: ExportWebContents;
  destroy(): void;
  isDestroyed(): boolean;
  loadFile(path: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): this;
  off(event: string, listener: (...args: never[]) => void): this;
  setContentSize(width: number, height: number, animate?: boolean): void;
}

interface ExportIpcMain {
  on(
    channel: string,
    listener: (event: IpcMainEvent, message: unknown) => void,
  ): this;
  off(
    channel: string,
    listener: (event: IpcMainEvent, message: unknown) => void,
  ): this;
}

export interface ExportFiles {
  access(path: string): Promise<void>;
  lstat(
    path: string,
    options: { bigint: true },
  ): Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  }>;
  rename(old_path: string, new_path: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

export type TargetIdentity =
  | Readonly<{ exists: false }>
  | Readonly<{
      exists: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtime_ns: bigint;
      ctime_ns: bigint;
    }>;

export type SavedExportArtifact = Readonly<{
  format: ExportFormat;
  path: string;
}>;

type ExportChild = ChildProcessWithoutNullStreams;

interface ElectronRuntime {
  BrowserWindow: new (options: BrowserWindowConstructorOptions) => ExportWindow;
  ipcMain: ExportIpcMain;
  packaged?: boolean;
}

export interface ExportHostDependencies {
  readonly files?: ExportFiles;
  readonly load_electron?: () => Promise<ElectronRuntime>;
  readonly now_uuid?: () => string;
  readonly protocol_timeout_ms?: number;
  readonly process_close_timeout_ms?: number;
  readonly resources_path?: string;
  readonly renderer_url?: string;
  readonly packaged?: boolean;
  readonly preload_path?: string;
  readonly export_html_path?: string;
  readonly spawn?: typeof node_spawn;
  readonly terminate_process?: (child: ExportChild) => Promise<void>;
  readonly verify_frame_probe?: (
    png: Buffer,
    expected_frame: number,
  ) => Promise<void> | void;
}

interface ProtocolWaiter {
  readonly kind: "initialized" | "frame-ready";
  readonly frame?: number;
  readonly resolve: () => void;
}

interface ChildOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class ExportCancelledError extends Error {
  constructor() {
    super("export cancelled");
    this.name = "ExportCancelledError";
  }
}

function readable_error(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function is_missing_file(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function file_exists(files: ExportFiles, path: string): Promise<boolean> {
  try {
    await files.access(path);
    return true;
  } catch (error) {
    if (is_missing_file(error)) return false;
    throw error;
  }
}

export function resolve_ffmpeg_executable(options: {
  readonly packaged: boolean;
  readonly resources_path?: string;
  readonly project_root?: string;
}): string {
  if (options.packaged) {
    if (!options.resources_path)
      throw new Error("process.resourcesPath is unavailable");
    return join(options.resources_path, "ffmpeg", "bin", "ffmpeg.exe");
  }
  return join(
    options.project_root ?? process.cwd(),
    "build",
    "ffmpeg",
    "win32-x64",
    "bin",
    "ffmpeg.exe",
  );
}

export function build_ffmpeg_args(output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    String(EXPORT_FPS),
    "-vcodec",
    "png",
    "-i",
    "pipe:0",
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-frames:v",
    String(EXPORT_FRAME_COUNT),
    output,
  ];
}

export function png_dimensions(png: Buffer): {
  readonly width: number;
  readonly height: number;
} {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    png.length < 24 ||
    !png.subarray(0, signature.length).equals(signature) ||
    png.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("captured frame is not a valid PNG IHDR stream");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export function append_bounded_stderr(
  previous: Buffer,
  chunk: Buffer | string,
  limit = EXPORT_STDERR_LIMIT,
): Buffer {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError("stderr limit must be a non-negative safe integer");
  if (limit === 0) return Buffer.alloc(0);
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (next.length >= limit) return next.subarray(next.length - limit);
  if (previous.length + next.length <= limit)
    return Buffer.concat([previous, next]);
  return Buffer.concat([
    previous.subarray(previous.length - (limit - next.length)),
    next,
  ]);
}

export async function write_with_backpressure(
  child: Pick<ExportChild, "stdin" | "once" | "off">,
  png: Buffer,
): Promise<void> {
  if (child.stdin.write(png)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.stdin.off("drain", on_drain);
      child.off("close", on_close);
      child.off("error", on_error);
    };
    const on_drain = () => {
      cleanup();
      resolve();
    };
    const on_close = () => {
      cleanup();
      reject(new Error("FFmpeg exited before stdin drained"));
    };
    const on_error = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.stdin.once("drain", on_drain);
    child.once("close", on_close);
    child.once("error", on_error);
  });
}

export async function commit_partial_output(
  files: ExportFiles,
  partial: string,
  destination: string,
  backup: string,
  checkpoint: () => void = () => undefined,
  verify_destination: () => Promise<void> = async () => undefined,
): Promise<boolean> {
  checkpoint();
  await verify_destination();
  const had_destination = await file_exists(files, destination);
  let backup_created = false;
  let partial_committed = false;
  try {
    if (had_destination) {
      await files.rename(destination, backup);
      backup_created = true;
      checkpoint();
    }
    await files.rename(partial, destination);
    partial_committed = true;
    return backup_created;
  } catch (error) {
    let rollback_error: Error | null = null;
    try {
      if (partial_committed) {
        if (backup_created) {
          await files.rm(destination, { force: true });
          await files.rename(backup, destination);
          backup_created = false;
        } else {
          await files.rename(destination, partial);
        }
      } else if (backup_created) {
        await files.rename(backup, destination);
        backup_created = false;
      }
    } catch (rollback) {
      rollback_error = readable_error(rollback);
    }
    if (rollback_error) {
      throw new Error(
        `${readable_error(error).message}; output rollback failed: ${rollback_error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function inspect_target_identity(
  files: Pick<ExportFiles, "lstat">,
  path: string,
): Promise<TargetIdentity> {
  try {
    const stat = await files.lstat(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("export target must be a regular file");
    return {
      exists: true,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtime_ns: stat.mtimeNs,
      ctime_ns: stat.ctimeNs,
    };
  } catch (error) {
    if (is_missing_file(error)) return { exists: false };
    throw error;
  }
}

export function target_identity_equal(
  left: TargetIdentity,
  right: TargetIdentity,
): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtime_ns === right.mtime_ns &&
    left.ctime_ns === right.ctime_ns
  );
}

async function default_electron_runtime(): Promise<ElectronRuntime> {
  const electron = createRequire(__filename)(
    "electron",
  ) as typeof import("electron");
  return {
    BrowserWindow:
      electron.BrowserWindow as unknown as ElectronRuntime["BrowserWindow"],
    ipcMain: electron.ipcMain as unknown as ExportIpcMain,
    packaged: electron.app.isPackaged,
  };
}

function window_options(preload: string): BrowserWindowConstructorOptions {
  return {
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
    useContentSize: true,
    show: false,
    resizable: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      preload,
      sandbox: true,
      spellcheck: false,
      zoomFactor: 1,
    },
  };
}

export class ExportHost {
  private readonly request: Readonly<ExportHostRequest>;
  private readonly files: ExportFiles;
  private task: Promise<void> | null = null;
  private window: ExportWindow | null = null;
  private ipc_main: ExportIpcMain | null = null;
  private child: ExportChild | null = null;
  private child_close: Promise<ChildOutcome> | null = null;
  private stderr: Buffer = Buffer.alloc(0);
  private readonly outputs = new Map<ExportFormat, OutputState>();
  private waiter: ProtocolWaiter | null = null;
  private terminal_error: Error | null = null;
  private reject_failure: ((error: Error) => void) | null = null;
  private failure: Promise<never> | null = null;
  private closing = false;
  private cancelled = false;
  private disposed = false;
  private ffmpeg_input_complete = false;
  private electron_packaged = false;
  private cleanup_failure: Error | null = null;
  private readonly target_identities = new Map<ExportFormat, TargetIdentity>();

  constructor(
    request: ExportHostRequest,
    private readonly dependencies: ExportHostDependencies = {},
  ) {
    if (!request.job_id || request.job_id.length > 128)
      throw new Error("invalid export job id");
    if (
      request.formats.length < 1 ||
      request.formats.length > 2 ||
      new Set(request.formats).size !== request.formats.length ||
      request.formats.some((format) => format !== "png" && format !== "mp4")
    )
      throw new Error("invalid export formats");
    for (const format of request.formats) {
      const destination = request.destinations[format];
      const identity = request.target_identities[format];
      if (
        !destination ||
        !isAbsolute(destination) ||
        destination.includes("\0")
      )
        throw new Error("export destination must be an absolute path");
      if (extname(destination).toLowerCase() !== `.${format}`)
        throw new Error(`export destination must end in .${format}`);
      if (!identity || typeof identity.exists !== "boolean")
        throw new Error(`missing ${format} target identity`);
      this.target_identities.set(format, identity);
    }
    const destinations = request.formats.map(
      (format) => request.destinations[format]!,
    );
    if (
      new Set(destinations.map(dirname)).size !== 1 ||
      new Set(
        request.formats.map((format) =>
          basename(request.destinations[format]!, `.${format}`),
        ),
      ).size !== 1
    )
      throw new Error("export destinations must share a directory and stem");
    this.request = Object.freeze({
      ...request,
      formats: Object.freeze([...request.formats]),
      destinations: Object.freeze({ ...request.destinations }),
      target_identities: Object.freeze({ ...request.target_identities }),
      view_model: structuredClone(request.view_model),
    });
    this.files = dependencies.files ?? node_files;
  }

  get active(): boolean {
    return this.task !== null;
  }

  get saved_artifacts(): SavedExportArtifact[] {
    return [...this.outputs.values()]
      .filter(({ committed }) => committed)
      .map(({ format, destination: path }) => ({ format, path }));
  }

  get residual_paths(): string[] {
    return [...this.outputs.values()].flatMap(({ partial, backup }) =>
      [partial, backup].filter(Boolean),
    );
  }

  get cleanup_failed(): boolean {
    return this.cleanup_failure !== null;
  }

  get cleanup_error(): Error | null {
    return this.cleanup_failure;
  }

  async inspect_residual_paths(): Promise<string[]> {
    const candidates = this.residual_paths;
    const present = await Promise.all(
      candidates.map(async (path) =>
        (await file_exists(this.files, path)) ? path : null,
      ),
    );
    return present.filter((path): path is string => path !== null);
  }

  start(): Promise<void> {
    if (this.disposed) throw new Error("export host is disposed");
    if (this.task) throw new Error("export host is already active");
    this.cancelled = false;
    this.closing = false;
    this.terminal_error = null;
    this.failure = new Promise<never>((_resolve, reject) => {
      this.reject_failure = reject;
    });
    void this.failure.catch(() => undefined);
    const task = this.run();
    this.task = task;
    void task.then(
      () => {
        if (this.task === task) this.task = null;
      },
      () => {
        if (this.task === task) this.task = null;
      },
    );
    return task;
  }

  async cancel(): Promise<void> {
    const task = this.task;
    if (!task) return;
    this.cancelled = true;
    this.fail(new ExportCancelledError());
    try {
      await task;
    } catch (error) {
      if (!(error instanceof ExportCancelledError)) throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.cancel();
    await this.cleanup_resources();
  }

  async retry_cleanup(): Promise<void> {
    if (this.task) throw new Error("export task is still active");
    await this.cleanup_resources();
  }

  private async run(): Promise<void> {
    let operation_error: Error | null = null;
    try {
      this.create_output_paths();
      this.report({ stage: "preparing" });
      await this.create_renderer();
      if (this.request.formats.includes("mp4"))
        await this.render_video_outputs();
      else await this.render_png_output();
      this.report({
        stage: "finalizing",
        committed: 0,
        artifact_total: this.request.formats.length,
      });
      for (const format of this.request.formats) {
        this.report({
          stage: "finalizing",
          format,
          committed: this.saved_artifacts.length,
          artifact_total: this.request.formats.length,
        });
        await this.commit_output(format);
      }
    } catch (reason) {
      operation_error = readable_error(reason);
    } finally {
      try {
        await this.cleanup_resources();
      } catch {
        // Cleanup state is exposed separately so the operation outcome wins.
      }
    }
    if (operation_error) throw operation_error;
    if (this.cleanup_failure) throw this.cleanup_failure;
  }

  private guard<T>(operation: Promise<T>): Promise<T> {
    if (this.terminal_error) return Promise.reject(this.terminal_error);
    return Promise.race([operation, this.failure!]);
  }

  private checkpoint(): void {
    if (this.terminal_error) throw this.terminal_error;
  }

  private fail(reason: unknown): void {
    if (this.terminal_error) return;
    const error = readable_error(reason);
    this.terminal_error = error;
    this.reject_failure?.(error);
  }

  private create_output_paths(): void {
    const uuid = (this.dependencies.now_uuid ?? randomUUID)();
    for (const format of this.request.formats) {
      const destination = this.request.destinations[format]!;
      const extension = `.${format}`;
      const stem = basename(destination, extension);
      const directory = dirname(destination);
      this.outputs.set(format, {
        format,
        destination,
        partial: join(directory, `.${stem}.${uuid}.partial${extension}`),
        backup: join(directory, `.${stem}.${uuid}.backup${extension}`),
        committed: false,
      });
    }
  }

  private report(progress: ExportHostProgress): void {
    this.request.on_progress?.(progress);
  }

  private async create_renderer(): Promise<void> {
    const runtime = await (
      this.dependencies.load_electron ?? default_electron_runtime
    )();
    this.electron_packaged = runtime.packaged ?? false;
    this.ipc_main = runtime.ipcMain;
    const preload =
      this.dependencies.preload_path ?? join(__dirname, "../preload/export.js");
    const window = new runtime.BrowserWindow(window_options(preload));
    this.window = window;
    window.setContentSize(EXPORT_WIDTH, EXPORT_HEIGHT, false);
    window.webContents.setBackgroundThrottling(false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.install_renderer_listeners(window);
    const renderer_url =
      this.dependencies.renderer_url ?? process.env.ELECTRON_RENDERER_URL;
    if (renderer_url) {
      const base = renderer_url.endsWith("/")
        ? renderer_url
        : `${renderer_url}/`;
      await this.guard(window.loadURL(new URL("export.html", base).toString()));
    } else {
      await this.guard(
        window.loadFile(
          this.dependencies.export_html_path ??
            join(__dirname, "../renderer/export.html"),
        ),
      );
    }
    window.webContents.setZoomFactor(1);
    const initialized = this.wait_for_protocol("initialized");
    window.webContents.send(EXPORT_RENDERER_CHANNELS.initialize, {
      job_id: this.request.job_id,
      view_model: this.request.view_model,
    });
    await initialized;
    await this.attach_cdp(window.webContents.debugger);
  }

  private install_renderer_listeners(window: ExportWindow): void {
    const web_contents = window.webContents;
    const navigation_listener = (event: { preventDefault(): void }) =>
      event.preventDefault();
    const failed_load_listener = (
      _event: unknown,
      code: number,
      description: string,
    ) =>
      this.fail(
        new Error(`export renderer failed to load (${code}): ${description}`),
      );
    const gone_listener = (_event: unknown, details: { reason?: string }) =>
      this.fail(
        new Error(
          `export renderer exited: ${details.reason ?? "unknown reason"}`,
        ),
      );
    const unresponsive_listener = () =>
      this.fail(new Error("export renderer became unresponsive"));
    const destroyed_listener = () => {
      if (!this.closing) this.fail(new Error("export renderer was destroyed"));
    };
    web_contents.on("will-navigate", navigation_listener as never);
    web_contents.on("did-fail-load", failed_load_listener as never);
    web_contents.on("render-process-gone", gone_listener as never);
    window.on("unresponsive", unresponsive_listener as never);
    window.on("closed", destroyed_listener as never);

    const initialized_listener = (event: IpcMainEvent, message: unknown) => {
      if (event.sender !== (web_contents as unknown)) return;
      if (
        !is_export_initialized_message(message) ||
        message.job_id !== this.request.job_id
      ) {
        this.fail(
          new Error("invalid initialized message from export renderer"),
        );
        return;
      }
      if (this.waiter?.kind !== "initialized") {
        this.fail(
          new Error("unexpected initialized message from export renderer"),
        );
        return;
      }
      this.waiter.resolve();
    };
    const frame_listener = (event: IpcMainEvent, message: unknown) => {
      if (event.sender !== (web_contents as unknown)) return;
      if (
        !is_export_frame_message(message) ||
        message.job_id !== this.request.job_id
      ) {
        this.fail(
          new Error("invalid frame-ready message from export renderer"),
        );
        return;
      }
      if (
        this.waiter?.kind !== "frame-ready" ||
        this.waiter.frame !== message.frame
      ) {
        this.fail(
          new Error("unexpected frame-ready message from export renderer"),
        );
        return;
      }
      this.waiter.resolve();
    };
    const failed_listener = (event: IpcMainEvent, message: unknown) => {
      if (event.sender !== (web_contents as unknown)) return;
      if (
        !is_export_failed_message(message) ||
        message.job_id !== this.request.job_id
      ) {
        this.fail(
          new Error("invalid renderer-failed message from export renderer"),
        );
        return;
      }
      this.fail(new Error(`export renderer failed: ${message.message}`));
    };
    this.ipc_main!.on(
      EXPORT_RENDERER_CHANNELS.initialized,
      initialized_listener,
    );
    this.ipc_main!.on(EXPORT_RENDERER_CHANNELS.frame_ready, frame_listener);
    this.ipc_main!.on(
      EXPORT_RENDERER_CHANNELS.renderer_failed,
      failed_listener,
    );
    this.renderer_listener_cleanup = () => {
      if (!web_contents.isDestroyed()) {
        web_contents.off("will-navigate", navigation_listener as never);
        web_contents.off("did-fail-load", failed_load_listener as never);
        web_contents.off("render-process-gone", gone_listener as never);
      }
      window.off("unresponsive", unresponsive_listener as never);
      window.off("closed", destroyed_listener as never);
      this.ipc_main?.off(
        EXPORT_RENDERER_CHANNELS.initialized,
        initialized_listener,
      );
      this.ipc_main?.off(EXPORT_RENDERER_CHANNELS.frame_ready, frame_listener);
      this.ipc_main?.off(
        EXPORT_RENDERER_CHANNELS.renderer_failed,
        failed_listener,
      );
    };
  }

  private renderer_listener_cleanup: (() => void) | null = null;

  private async wait_for_protocol(
    kind: ProtocolWaiter["kind"],
    frame?: number,
  ): Promise<void> {
    if (this.waiter) throw new Error("export renderer request is not serial");
    let timer: NodeJS.Timeout | undefined;
    const response = new Promise<void>((resolve) => {
      this.waiter = { kind, frame, resolve };
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`export renderer ${kind} timed out`)),
        this.dependencies.protocol_timeout_ms ?? 30_000,
      );
    });
    try {
      await this.guard(Promise.race([response, timeout]));
    } finally {
      if (timer) clearTimeout(timer);
      this.waiter = null;
    }
  }

  private async attach_cdp(debugger_api: ExportDebugger): Promise<void> {
    debugger_api.attach("1.3");
    await this.guard(debugger_api.sendCommand("Page.enable"));
    await this.guard(
      debugger_api.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: EXPORT_WIDTH,
        height: EXPORT_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: EXPORT_WIDTH,
        screenHeight: EXPORT_HEIGHT,
      }),
    );
  }

  private async capture_frame(frame: number): Promise<Buffer> {
    const window = this.window;
    if (!window) throw new Error("export renderer is unavailable");
    const ready = this.wait_for_protocol("frame-ready", frame);
    window.webContents.send(EXPORT_RENDERER_CHANNELS.render_frame, {
      job_id: this.request.job_id,
      frame,
    });
    await ready;
    const result = await this.guard(
      window.webContents.debugger.sendCommand("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      }),
    );
    if (
      typeof result !== "object" ||
      result === null ||
      !("data" in result) ||
      typeof result.data !== "string"
    ) {
      throw new Error("CDP returned an invalid screenshot response");
    }
    const png = Buffer.from(result.data, "base64");
    const dimensions = png_dimensions(png);
    if (
      dimensions.width !== EXPORT_WIDTH ||
      dimensions.height !== EXPORT_HEIGHT
    )
      throw new Error(
        `captured frame has ${dimensions.width}x${dimensions.height}, expected ${EXPORT_WIDTH}x${EXPORT_HEIGHT}`,
      );
    if (this.dependencies.verify_frame_probe) {
      await this.guard(
        Promise.resolve(this.dependencies.verify_frame_probe(png, frame)),
      );
    }
    return png;
  }

  private async render_png_output(): Promise<void> {
    this.report({ stage: "rendering" });
    const png = await this.capture_frame(EXPORT_PNG_FRAME);
    this.checkpoint();
    await this.files.writeFile(this.outputs.get("png")!.partial, png);
    this.report({ stage: "rendering", png_written: true });
  }

  private async render_video_outputs(): Promise<void> {
    const mp4 = this.outputs.get("mp4")!;
    const executable = resolve_ffmpeg_executable({
      packaged: this.dependencies.packaged ?? this.electron_packaged,
      resources_path: this.dependencies.resources_path ?? process.resourcesPath,
    });
    const child = (this.dependencies.spawn ?? node_spawn)(
      executable,
      build_ffmpeg_args(mp4.partial),
      { stdio: "pipe", windowsHide: true },
    ) as ExportChild;
    this.child = child;
    this.ffmpeg_input_complete = false;
    this.stderr = Buffer.alloc(0);
    child.stdout.resume();
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderr = append_bounded_stderr(this.stderr, chunk);
    });
    this.child_close = new Promise<ChildOutcome>((resolve, reject) => {
      child.once("error", (error) => {
        reject(error);
        if (!this.ffmpeg_input_complete && !this.closing) this.fail(error);
      });
      child.once("close", (code, signal) => {
        resolve({ code, signal });
        if (!this.ffmpeg_input_complete && !this.closing)
          this.fail(
            new Error("FFmpeg exited before all export frames were written"),
          );
      });
    });
    child.stdin.on("error", (error) => {
      if (!this.ffmpeg_input_complete && !this.closing) this.fail(error);
    });
    void this.child_close.catch(() => undefined);
    this.report({
      stage: "rendering",
      completed: 0,
      total: EXPORT_FRAME_COUNT,
    });
    for (let frame = 0; frame < EXPORT_FRAME_COUNT; frame += 1) {
      const png = await this.capture_frame(frame);
      let png_written = false;
      if (frame === EXPORT_PNG_FRAME && this.outputs.has("png")) {
        this.checkpoint();
        await this.files.writeFile(this.outputs.get("png")!.partial, png);
        png_written = true;
      }
      await this.guard(write_with_backpressure(child, png));
      this.report({
        stage: "rendering",
        completed: frame + 1,
        total: EXPORT_FRAME_COUNT,
        ...(png_written ? { png_written: true } : {}),
      });
    }
    this.ffmpeg_input_complete = true;
    child.stdin.end();
    const outcome = await this.guard(this.child_close);
    this.child = null;
    this.child_close = null;
    if (outcome.code !== 0) {
      const detail = this.stderr.toString("utf8").trim();
      throw new Error(
        `FFmpeg failed with ${outcome.code ?? outcome.signal ?? "unknown status"}${detail ? `: ${detail}` : ""}`,
      );
    }
  }

  private async commit_output(format: ExportFormat): Promise<void> {
    const output = this.outputs.get(format)!;
    this.checkpoint();
    const backup_created = await commit_partial_output(
      this.files,
      output.partial,
      output.destination,
      output.backup,
      () => this.checkpoint(),
      async () => {
        const expected = this.target_identities.get(format)!;
        const actual = await inspect_target_identity(
          this.files,
          output.destination,
        );
        if (!target_identity_equal(expected, actual))
          throw new Error(
            `${format.toUpperCase()} export target changed before commit`,
          );
      },
    );
    output.partial = "";
    if (!backup_created) output.backup = "";
    output.committed = true;
    this.report({
      stage: "finalizing",
      format,
      committed: this.saved_artifacts.length,
      artifact_total: this.request.formats.length,
    });
  }

  private async stop_ffmpeg(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.ffmpeg_input_complete = true;
    try {
      child.stdin.end();
    } catch {
      // The process may already have closed.
    }
    if (this.dependencies.terminate_process) {
      await this.dependencies.terminate_process(child);
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    if (this.child_close) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.child_close.catch(() => ({ code: null, signal: null })),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("FFmpeg process close timed out")),
              this.dependencies.process_close_timeout_ms ?? 10_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.child = null;
    this.child_close = null;
  }

  private async cleanup_resources(): Promise<void> {
    this.closing = true;
    const cleanup_errors: string[] = [];
    try {
      await this.stop_ffmpeg();
    } catch (error) {
      cleanup_errors.push(`FFmpeg: ${readable_error(error).message}`);
    }
    const window = this.window;
    if (window) {
      let window_clean = false;
      const window_errors: string[] = [];
      try {
        if (!window.isDestroyed()) {
          const web_contents = window.webContents;
          if (!web_contents.isDestroyed() && web_contents.debugger.isAttached())
            web_contents.debugger.detach();
        }
      } catch (error) {
        window_errors.push(`CDP: ${readable_error(error).message}`);
      }
      try {
        if (!window.isDestroyed()) window.destroy();
        window_clean = true;
      } catch (error) {
        window_errors.push(`导出窗口: ${readable_error(error).message}`);
      }
      if (window_clean) {
        this.renderer_listener_cleanup?.();
        this.renderer_listener_cleanup = null;
        this.window = null;
        this.ipc_main = null;
      } else {
        cleanup_errors.push(...window_errors);
      }
    }
    for (const output of this.outputs.values()) {
      for (const kind of ["partial", "backup"] as const) {
        const path = output[kind];
        if (!path) continue;
        try {
          await this.files.rm(path, { force: true });
          output[kind] = "";
        } catch (error) {
          cleanup_errors.push(
            `${basename(path)}: ${readable_error(error).message}`,
          );
        }
      }
    }
    if (cleanup_errors.length > 0) {
      this.cleanup_failure = new Error(cleanup_errors.join("; "));
      throw this.cleanup_failure;
    }
    this.cleanup_failure = null;
  }
}
