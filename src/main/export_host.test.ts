import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import type { CDFViewModel } from "../visualize/types/cdf";
import { EXPORT_RENDERER_CHANNELS } from "../shared/export_renderer";
import {
  append_bounded_stderr,
  build_ffmpeg_args,
  commit_partial_output,
  EXPORT_FPS,
  EXPORT_FRAME_COUNT,
  EXPORT_HEIGHT,
  ExportHost,
  type ExportFiles,
  type ExportHostDependencies,
  EXPORT_PNG_FRAME,
  EXPORT_STDERR_LIMIT,
  EXPORT_WIDTH,
  inspect_target_identity,
  png_dimensions,
  resolve_ffmpeg_executable,
  write_with_backpressure,
} from "./export_host";

const test_root = mkdtempSync(join(tmpdir(), "gachasimulate-export-host-"));
after(() => rm(test_root, { recursive: true, force: true }));

function fake_png(width = EXPORT_WIDTH, height = EXPORT_HEIGHT): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test("resolves only pinned development and packaged FFmpeg paths", () => {
  assert.equal(
    resolve_ffmpeg_executable({
      packaged: false,
      project_root: resolve("project"),
    }),
    resolve("project/build/ffmpeg/win32-x64/bin/ffmpeg.exe"),
  );
  assert.equal(
    resolve_ffmpeg_executable({
      packaged: true,
      resources_path: resolve("resources"),
    }),
    resolve("resources/ffmpeg/bin/ffmpeg.exe"),
  );
  assert.throws(
    () => resolve_ffmpeg_executable({ packaged: true }),
    /resourcesPath/,
  );
});

test("uses the fixed 60 FPS image2pipe H.264 contract", () => {
  const output = resolve("video.partial.mp4");
  const args = build_ffmpeg_args(output);
  assert.deepEqual(args, [
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
  ]);
});

test("validates the PNG signature, IHDR, and dimensions", () => {
  assert.deepEqual(png_dimensions(fake_png()), {
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
  });
  assert.throws(() => png_dimensions(Buffer.alloc(24)), /valid PNG/);
});

test("caps FFmpeg stderr by bytes and retains the newest diagnostics", () => {
  let stderr = append_bounded_stderr(Buffer.alloc(0), "old", 5);
  stderr = append_bounded_stderr(stderr, "-new", 5);
  assert.equal(stderr.toString(), "d-new");
  stderr = append_bounded_stderr(
    stderr,
    Buffer.alloc(EXPORT_STDERR_LIMIT + 1, 1),
  );
  assert.equal(stderr.length, EXPORT_STDERR_LIMIT);
});

class BackpressureChild extends EventEmitter {
  readonly stdin = new PassThrough();
}

class FakeFfmpegChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(output: string) {
    super();
    this.stdin.once("finish", () => {
      writeFileSync(output, "fake-mp4");
      this.exitCode = 0;
      queueMicrotask(() => this.emit("close", 0, null));
    });
  }

  kill(): boolean {
    this.signalCode = "SIGTERM";
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

test("waits for drain after FFmpeg backpressure", async () => {
  const child = new BackpressureChild();
  child.stdin.write = () => false;
  const writing = write_with_backpressure(child as never, Buffer.from("png"));
  let settled = false;
  void writing.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  child.stdin.emit("drain");
  await writing;
  assert.equal(settled, true);
});

test("rejects a backpressured write when FFmpeg exits early", async () => {
  const child = new BackpressureChild();
  child.stdin.write = () => false;
  const writing = write_with_backpressure(child as never, Buffer.from("png"));
  child.emit("close", 1, null);
  await assert.rejects(writing, /exited before stdin drained/);
});

test("restores an existing destination when partial commit fails", async () => {
  const directory = await mkdtemp(join(test_root, "rollback-"));
  const destination = join(directory, "result.png");
  const partial = join(directory, ".result.partial.png");
  const backup = join(directory, ".result.backup.png");
  await writeFile(destination, "old");
  await writeFile(partial, "new");
  const files: ExportFiles = {
    access,
    lstat,
    rm: (path, options) => rm(path, options),
    writeFile,
    async rename(old_path, new_path) {
      if (old_path === partial && new_path === destination)
        throw new Error("injected rename failure");
      await rename(old_path, new_path);
    },
  };
  await assert.rejects(
    commit_partial_output(files, partial, destination, backup),
    /injected rename failure/,
  );
  assert.equal(await readFile(destination, "utf8"), "old");
  assert.equal(await readFile(partial, "utf8"), "new");
  await assert.rejects(access(backup), { code: "ENOENT" });
});

test("restores the old destination when cancellation reaches the commit checkpoint", async () => {
  const directory = await mkdtemp(join(test_root, "cancel-commit-"));
  const destination = join(directory, "result.png");
  const partial = join(directory, ".result.partial.png");
  const backup = join(directory, ".result.backup.png");
  await writeFile(destination, "old");
  await writeFile(partial, "new");
  let checkpoints = 0;
  await assert.rejects(
    commit_partial_output(
      { access, lstat, rename, rm, writeFile },
      partial,
      destination,
      backup,
      () => {
        checkpoints += 1;
        if (checkpoints === 2) throw new Error("cancelled");
      },
    ),
    /cancelled/,
  );
  assert.equal(await readFile(destination, "utf8"), "old");
  assert.equal(await readFile(partial, "utf8"), "new");
});

class FakeIpcMain extends EventEmitter {}

class FakeApp extends EventEmitter {
  quit_calls = 0;
  quit(): void {
    this.quit_calls += 1;
  }
}

class FakeDebugger {
  attached = false;
  readonly commands: string[] = [];
  constructor(private readonly png: Buffer) {}
  attach(): void {
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
  }
  isAttached(): boolean {
    return this.attached;
  }
  async sendCommand(method: string): Promise<unknown> {
    this.commands.push(method);
    if (method === "Page.captureScreenshot")
      return { data: this.png.toString("base64") };
    return {};
  }
}

class FakeWebContents extends EventEmitter {
  destroyed = false;
  readonly debugger: FakeDebugger;
  readonly sent: Array<{ channel: string; message: unknown }> = [];
  readonly zoom_factors: number[] = [];
  constructor(
    png: Buffer,
    private readonly ipc: FakeIpcMain,
    private readonly answer: boolean,
  ) {
    super();
    this.debugger = new FakeDebugger(png);
  }
  send(channel: string, message: unknown): void {
    this.sent.push({ channel, message });
    if (!this.answer) return;
    if (channel === EXPORT_RENDERER_CHANNELS.initialize) {
      queueMicrotask(() =>
        this.ipc.emit(
          EXPORT_RENDERER_CHANNELS.initialized,
          { sender: this },
          {
            job_id: "job",
          },
        ),
      );
    } else if (channel === EXPORT_RENDERER_CHANNELS.render_frame) {
      queueMicrotask(() =>
        this.ipc.emit(
          EXPORT_RENDERER_CHANNELS.frame_ready,
          { sender: this },
          message,
        ),
      );
    }
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  setBackgroundThrottling(): void {}
  setWindowOpenHandler(): void {}
  setZoomFactor(factor: number): void {
    this.zoom_factors.push(factor);
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  destroy_error = false;
  readonly webContents: FakeWebContents;
  constructor(png: Buffer, ipc: FakeIpcMain, answer: boolean) {
    super();
    this.webContents = new FakeWebContents(png, ipc, answer);
  }
  destroy(): void {
    if (this.destroy_error) throw new Error("window is busy");
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit("closed");
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  async loadFile(): Promise<void> {}
  async loadURL(): Promise<void> {}
  setContentSize(): void {}
}

function fake_host_dependencies(
  answer = true,
  with_app = false,
): {
  readonly dependencies: ExportHostDependencies;
  readonly app: FakeApp;
  readonly options: unknown[];
  readonly windows: FakeWindow[];
} {
  const ipc = new FakeIpcMain();
  const app = new FakeApp();
  const options: unknown[] = [];
  const windows: FakeWindow[] = [];
  const BrowserWindow = class {
    constructor(window_options: unknown) {
      options.push(window_options);
      const window = new FakeWindow(fake_png(), ipc, answer);
      windows.push(window);
      return window;
    }
  };
  return {
    dependencies: {
      export_html_path: resolve("export.html"),
      load_electron: async () =>
        ({
          BrowserWindow,
          ipcMain: ipc,
          packaged: false,
          app: with_app ? app : undefined,
        }) as never,
      now_uuid: () => "unit-test",
      protocol_timeout_ms: 1_000,
      preload_path: resolve("export-preload.js"),
    },
    app,
    options,
    windows,
  };
}

test("ExportHost renders PNG frame 57 through the serial renderer/CDP protocol", async () => {
  const output = join(test_root, "host.png");
  const fixture = fake_host_dependencies();
  const verified: number[] = [];
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["png"],
      view_model: {} as CDFViewModel,
      destinations: { png: output },
      target_identities: { png: { exists: false } },
    },
    {
      ...fixture.dependencies,
      verify_frame_probe: (_png, frame) => void verified.push(frame),
    },
  );
  await host.start();
  assert.equal(host.active, false);
  assert.deepEqual(verified, [EXPORT_PNG_FRAME]);
  assert.deepEqual(png_dimensions(await readFile(output)), {
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
  });
  const window = fixture.windows[0];
  assert.equal(window.destroyed, true);
  assert.deepEqual(window.webContents.zoom_factors, [1]);
  assert.deepEqual(fixture.options, [
    {
      height: EXPORT_HEIGHT,
      resizable: false,
      show: false,
      useContentSize: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
        preload: resolve("export-preload.js"),
        sandbox: true,
        spellcheck: false,
        zoomFactor: 1,
      },
      width: EXPORT_WIDTH,
    },
  ]);
  assert.deepEqual(window.webContents.debugger.commands, [
    "Page.enable",
    "Emulation.setDeviceMetricsOverride",
    "Page.captureScreenshot",
  ]);
  assert.deepEqual(
    window.webContents.sent.map(({ channel, message }) => ({
      channel,
      frame:
        typeof message === "object" && message && "frame" in message
          ? message.frame
          : null,
    })),
    [
      { channel: EXPORT_RENDERER_CHANNELS.initialize, frame: null },
      {
        channel: EXPORT_RENDERER_CHANNELS.render_frame,
        frame: EXPORT_PNG_FRAME,
      },
    ],
  );
});

test("ExportHost refuses a destination created while rendering", async () => {
  const output = join(test_root, "raced.png");
  const fixture = fake_host_dependencies();
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["png"],
      view_model: {} as CDFViewModel,
      destinations: { png: output },
      target_identities: { png: { exists: false } },
    },
    {
      ...fixture.dependencies,
      verify_frame_probe: async () => writeFile(output, "external-change"),
    },
  );
  await assert.rejects(host.start(), /target changed before commit/);
  assert.equal(await readFile(output, "utf8"), "external-change");
  assert.deepEqual(host.saved_artifacts, []);
});

test("ExportHost reuses frame 57 for a dual MP4 and PNG export", async () => {
  const directory = await mkdtemp(join(test_root, "dual-"));
  const fixture = fake_host_dependencies();
  const frames: number[] = [];
  const progress: Array<{ completed?: number; png_written?: boolean }> = [];
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["mp4", "png"],
      view_model: {} as CDFViewModel,
      destinations: {
        mp4: join(directory, "result.mp4"),
        png: join(directory, "result.png"),
      },
      target_identities: {
        mp4: { exists: false },
        png: { exists: false },
      },
      on_progress: (event) => progress.push(event),
    },
    {
      ...fixture.dependencies,
      spawn: ((_command: string, args: string[]) =>
        new FakeFfmpegChild(args.at(-1)!)) as never,
      verify_frame_probe: (_png, frame) => void frames.push(frame),
    },
  );
  await host.start();
  assert.deepEqual(
    frames,
    Array.from({ length: EXPORT_FRAME_COUNT }, (_, i) => i),
  );
  assert.equal(frames.filter((frame) => frame === EXPORT_PNG_FRAME).length, 1);
  assert.equal(
    await readFile(join(directory, "result.mp4"), "utf8"),
    "fake-mp4",
  );
  assert.deepEqual(
    png_dimensions(await readFile(join(directory, "result.png"))),
    {
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
    },
  );
  assert.equal(
    progress.some((event) => event.png_written),
    true,
  );
  assert.equal(
    progress.some((event) => event.completed === EXPORT_FRAME_COUNT),
    true,
  );
  assert.deepEqual(
    host.saved_artifacts.map(({ format }) => format),
    ["mp4", "png"],
  );
});

test("dual export preserves the first commit when the second target changes", async () => {
  const directory = await mkdtemp(join(test_root, "dual-race-"));
  const mp4_output = join(directory, "result.mp4");
  const png_output = join(directory, "result.png");
  const fixture = fake_host_dependencies();
  const files: ExportFiles = {
    access,
    lstat,
    rm: (path, options) => rm(path, options),
    writeFile,
    async rename(old_path, new_path) {
      await rename(old_path, new_path);
      if (new_path === mp4_output) await writeFile(png_output, "external-png");
    },
  };
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["mp4", "png"],
      view_model: {} as CDFViewModel,
      destinations: { mp4: mp4_output, png: png_output },
      target_identities: {
        mp4: { exists: false },
        png: { exists: false },
      },
    },
    {
      ...fixture.dependencies,
      files,
      spawn: ((_command: string, args: string[]) =>
        new FakeFfmpegChild(args.at(-1)!)) as never,
    },
  );
  await assert.rejects(host.start(), /PNG export target changed/);
  assert.equal(await readFile(mp4_output, "utf8"), "fake-mp4");
  assert.equal(await readFile(png_output, "utf8"), "external-png");
  assert.deepEqual(
    host.saved_artifacts.map(({ format }) => format),
    ["mp4"],
  );
});

test("committed output survives backup cleanup failure and retries only the residual backup", async () => {
  const directory = await mkdtemp(join(test_root, "backup-cleanup-"));
  const output = join(directory, "result.png");
  await writeFile(output, "old");
  const identity = await inspect_target_identity({ lstat }, output);
  const fixture = fake_host_dependencies();
  let block_backup = true;
  const removed: string[] = [];
  const files: ExportFiles = {
    access,
    lstat,
    rename,
    writeFile,
    async rm(path, options) {
      if (path.includes(".backup.png") && block_backup)
        throw new Error("backup is locked");
      removed.push(path);
      await rm(path, options);
    },
  };
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["png"],
      view_model: {} as CDFViewModel,
      destinations: { png: output },
      target_identities: { png: identity },
    },
    { ...fixture.dependencies, files },
  );

  await assert.rejects(host.start(), /backup is locked/);
  assert.equal(host.saved_artifacts.length, 1);
  assert.deepEqual(png_dimensions(await readFile(output)), {
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
  });
  assert.equal(host.cleanup_failed, true);
  assert.equal(host.residual_paths.length, 1);

  const removal_count = removed.length;
  block_backup = false;
  await host.retry_cleanup();
  assert.equal(host.cleanup_failed, false);
  assert.deepEqual(host.residual_paths, []);
  assert.equal(removed.length, removal_count + 1);
});

test("partial cleanup failure remains retryable without touching an external destination", async () => {
  const directory = await mkdtemp(join(test_root, "partial-cleanup-"));
  const output = join(directory, "result.png");
  const fixture = fake_host_dependencies();
  let block_partial = true;
  const files: ExportFiles = {
    access,
    lstat,
    rename,
    writeFile,
    async rm(path, options) {
      if (path.includes(".partial.png") && block_partial)
        throw new Error("partial is locked");
      await rm(path, options);
    },
  };
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["png"],
      view_model: {} as CDFViewModel,
      destinations: { png: output },
      target_identities: { png: { exists: false } },
    },
    {
      ...fixture.dependencies,
      files,
      verify_frame_probe: async () => writeFile(output, "external"),
    },
  );

  await assert.rejects(host.start(), /target changed before commit/);
  assert.equal(await readFile(output, "utf8"), "external");
  assert.equal(host.cleanup_failed, true);
  assert.equal(host.residual_paths.length, 1);
  block_partial = false;
  await host.retry_cleanup();
  assert.deepEqual(host.residual_paths, []);
});

test("failed FFmpeg termination is retained and retried", async () => {
  const directory = await mkdtemp(join(test_root, "ffmpeg-cleanup-"));
  const fixture = fake_host_dependencies();
  let child: FakeFfmpegChild | null = null;
  let termination_attempts = 0;
  let probe_started!: () => void;
  const entered_probe = new Promise<void>((resolve) => {
    probe_started = resolve;
  });
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["mp4"],
      view_model: {} as CDFViewModel,
      destinations: { mp4: join(directory, "result.mp4") },
      target_identities: { mp4: { exists: false } },
    },
    {
      ...fixture.dependencies,
      spawn: ((_command: string, args: string[]) => {
        child = new FakeFfmpegChild(args.at(-1)!);
        return child;
      }) as never,
      verify_frame_probe: async () => {
        probe_started();
        await new Promise(() => undefined);
      },
      terminate_process: async () => {
        termination_attempts += 1;
        if (termination_attempts === 1) throw new Error("terminate failed");
        child!.kill();
      },
    },
  );
  const running = host.start();
  await entered_probe;
  await host.cancel();
  await assert.rejects(running, /export cancelled/);
  assert.equal(host.cleanup_failed, true);
  assert.equal(termination_attempts, 1);
  await host.retry_cleanup();
  assert.equal(termination_attempts, 2);
  assert.equal(host.cleanup_failed, false);
});

test("failed hidden-window destruction remains retryable", async () => {
  const fixture = fake_host_dependencies(false);
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["png"],
      view_model: {} as CDFViewModel,
      destinations: { png: join(test_root, "window-cleanup.png") },
      target_identities: { png: { exists: false } },
    },
    fixture.dependencies,
  );
  const running = host.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  fixture.windows[0].destroy_error = true;
  await host.cancel();
  await assert.rejects(running, /export cancelled/);
  assert.equal(host.cleanup_failed, true);
  fixture.windows[0].destroy_error = false;
  await host.retry_cleanup();
  assert.equal(fixture.windows[0].destroyed, true);
  assert.equal(host.cleanup_failed, false);
});

test("ExportHost cancellation destroys a renderer awaiting initialization", async () => {
  const fixture = fake_host_dependencies(false);
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["png"],
      view_model: {} as CDFViewModel,
      destinations: { png: join(test_root, "cancelled.png") },
      target_identities: { png: { exists: false } },
    },
    fixture.dependencies,
  );
  const running = host.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(host.active, true);
  await host.cancel();
  await assert.rejects(running, /export cancelled/);
  assert.equal(host.active, false);
  assert.equal(fixture.windows[0].destroyed, true);
});

test("ExportHost preserves the renderer-destroyed failure during cleanup", async () => {
  const fixture = fake_host_dependencies(false);
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["png"],
      view_model: {} as CDFViewModel,
      destinations: { png: join(test_root, "renderer-destroyed.png") },
      target_identities: { png: { exists: false } },
    },
    fixture.dependencies,
  );
  const running = host.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  fixture.windows[0].destroy();
  await assert.rejects(running, /export renderer was destroyed/);
  assert.equal(host.active, false);
});

test("ExportHost cancellation interrupts a pending frame probe", async () => {
  const fixture = fake_host_dependencies();
  let entered_probe: (() => void) | undefined;
  const probe_started = new Promise<void>((resolve) => {
    entered_probe = resolve;
  });
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["png"],
      view_model: {} as CDFViewModel,
      destinations: { png: join(test_root, "cancelled-probe.png") },
      target_identities: { png: { exists: false } },
    },
    {
      ...fixture.dependencies,
      verify_frame_probe: async () => {
        entered_probe?.();
        await new Promise(() => undefined);
      },
    },
  );
  const running = host.start();
  await probe_started;
  await host.cancel();
  await assert.rejects(running, /export cancelled/);
  assert.equal(host.active, false);
  assert.equal(fixture.windows[0].destroyed, true);
});

test("ExportHost dispose waits until active resources are cleaned", async () => {
  const fixture = fake_host_dependencies(false, true);
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["png"],
      view_model: {} as CDFViewModel,
      destinations: { png: join(test_root, "app-exit.png") },
      target_identities: { png: { exists: false } },
    },
    fixture.dependencies,
  );
  const running = host.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await host.dispose();
  await assert.rejects(running, /export cancelled/);
  assert.equal(host.active, false);
  assert.equal(fixture.windows[0].destroyed, true);
});
