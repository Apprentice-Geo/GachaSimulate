import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import {
  access,
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
      { access, rename, rm, writeFile },
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
  readonly webContents: FakeWebContents;
  constructor(png: Buffer, ipc: FakeIpcMain, answer: boolean) {
    super();
    this.webContents = new FakeWebContents(png, ipc, answer);
  }
  destroy(): void {
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

test("ExportHost cancellation destroys a renderer awaiting initialization", async () => {
  const fixture = fake_host_dependencies(false);
  const host = new ExportHost(
    {
      job_id: "job",
      formats: ["png"],
      view_model: {} as CDFViewModel,
      destinations: { png: join(test_root, "cancelled.png") },
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
