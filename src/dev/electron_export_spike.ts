import assert from "node:assert/strict";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  _electron as electron,
  type CDPSession,
  type ElectronApplication,
  type Page,
} from "playwright";
import { CANVAS_HEIGHT, CANVAS_WIDTH, VIDEO_FPS } from "../visualize/constants";
import { emulate_viewport } from "./electron_viewport";
import {
  select_backend,
  type BackendAggregate,
  type SpikeThresholds,
} from "./electron_export_spike_metrics";
import type {
  ExportSpikeBarrier,
  ExportSpikeReady,
} from "../renderer/ExportSpikeApp";

const exec_file = promisify(execFile);
const PROJECT_ROOT = process.cwd();
const FRAME_COUNT = 60;
const BARRIERS: ExportSpikeBarrier[] = ["commit", "fonts", "raf", "double-raf"];
const BACKENDS = ["capture-page", "cdp"] as const;
type Backend = (typeof BACKENDS)[number];

const THRESHOLDS: SpikeThresholds = {
  screenshot_total_ms: 20_000,
  ffmpeg_total_ms: 30_000,
  response_p95_ms: 100,
  response_max_ms: 250,
};

interface CliOptions {
  ffmpeg: string;
  output: string;
  quick: boolean;
}

interface CaptureMetric {
  backend: Backend;
  frame: number;
  ready_ms: number;
  capture_ms: number;
  encode_ms: number;
  transfer_ms: number;
  png_bytes: number;
  probe_frame: number | null;
}

interface SequenceMetric {
  backend: Backend;
  barrier: ExportSpikeBarrier;
  mode: "correctness" | "screenshot" | "ffmpeg";
  repeat: number;
  total_ms: number;
  frames: CaptureMetric[];
  errors: string[];
  stdin_backpressure_count: number;
  stdin_write_ms: number[];
  stdin_drain_ms: number[];
  main_loop_delay_ms: number[];
  ui_probe_ms: number[];
  electron_peak_working_set_kb: number;
  ffmpeg_peak_working_set_bytes: number;
  artifact?: {
    path: string;
    sha256: string;
    bytes: number;
    ffprobe: unknown;
  };
  ffmpeg_args?: string[];
  ffmpeg_stderr?: string;
}

interface CapturedFrame {
  metric: CaptureMetric;
  png: Buffer;
}

function parse_args(argv: string[]): CliOptions {
  let ffmpeg = "ffmpeg";
  let output = path.join(
    PROJECT_ROOT,
    "docs",
    "experiments",
    "electron-export-phase0",
    "windows-2026-08-27.json",
  );
  let quick = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ffmpeg" && argv[index + 1]) ffmpeg = argv[++index];
    else if (argument === "--output" && argv[index + 1])
      output = path.resolve(argv[++index]);
    else if (argument === "--quick") quick = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return { ffmpeg, output, quick };
}

function png_size(png: Buffer): { width: number; height: number } {
  assert.ok(png.length >= 24, "screenshot is too short to be a PNG");
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function hash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function set_frame(
  page: Page,
  frame: number,
  barrier: ExportSpikeBarrier,
): Promise<{ ready: ExportSpikeReady; elapsed_ms: number }> {
  const started = performance.now();
  const ready = await page.evaluate(
    ([next_frame, next_barrier]) => {
      if (!window.electronExportSpike)
        throw new Error("export spike page is not ready");
      return window.electronExportSpike.setFrame(next_frame, next_barrier);
    },
    [frame, barrier] as const,
  );
  return { ready, elapsed_ms: performance.now() - started };
}

async function decode_probe(
  application: ElectronApplication,
  base64: string,
): Promise<number> {
  return application.evaluate(({ nativeImage }, png_base64) => {
    const image = nativeImage.createFromBuffer(
      Buffer.from(png_base64, "base64"),
    );
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    const start_offset = ((height - 8) * width + 8) * 4;
    const end_offset = ((height - 8) * width + 9 * 16 + 8) * 4;
    if (
      bitmap[start_offset] +
        bitmap[start_offset + 1] +
        bitmap[start_offset + 2] <=
        500 ||
      bitmap[end_offset] + bitmap[end_offset + 1] + bitmap[end_offset + 2] <=
        500
    )
      return -1;
    let frame = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const offset = ((height - 8) * width + (bit + 1) * 16 + 8) * 4;
      if (bitmap[offset] + bitmap[offset + 1] + bitmap[offset + 2] > 500)
        frame |= 1 << bit;
    }
    return frame;
  }, base64);
}

async function capture_frame(
  application: ElectronApplication,
  cdp: CDPSession,
  backend: Backend,
  frame: number,
  ready_ms: number,
  verify_probe = true,
): Promise<CapturedFrame> {
  if (backend === "capture-page") {
    const transfer_started = performance.now();
    const result = await application.evaluate(async ({ BrowserWindow }) => {
      let window: Electron.BrowserWindow | undefined;
      for (const candidate of BrowserWindow.getAllWindows()) {
        if (candidate.webContents.getURL().includes("electron-export-spike")) {
          window = candidate;
          break;
        }
      }
      if (!window) throw new Error("offscreen export window is missing");
      const capture_started = globalThis.performance.now();
      const image = await window.capturePage(undefined, { stayHidden: true });
      const capture_ms = globalThis.performance.now() - capture_started;
      const encode_started = globalThis.performance.now();
      const png = image.toPNG();
      return {
        capture_ms,
        encode_ms: globalThis.performance.now() - encode_started,
        png: png.toString("base64"),
      };
    });
    const transfer_ms =
      performance.now() -
      transfer_started -
      result.capture_ms -
      result.encode_ms;
    const png = Buffer.from(result.png, "base64");
    assert.deepEqual(png_size(png), {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
    });
    return {
      png,
      metric: {
        backend,
        frame,
        ready_ms,
        capture_ms: result.capture_ms,
        encode_ms: result.encode_ms,
        transfer_ms: Math.max(0, transfer_ms),
        png_bytes: png.length,
        probe_frame: verify_probe
          ? await decode_probe(application, result.png)
          : null,
      },
    };
  }

  const capture_started = performance.now();
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const capture_ms = performance.now() - capture_started;
  const decode_started = performance.now();
  const png = Buffer.from(result.data, "base64");
  const encode_ms = performance.now() - decode_started;
  assert.deepEqual(png_size(png), {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
  });
  return {
    png,
    metric: {
      backend,
      frame,
      ready_ms,
      capture_ms,
      encode_ms,
      transfer_ms: 0,
      png_bytes: png.length,
      probe_frame: verify_probe
        ? await decode_probe(application, result.data)
        : null,
    },
  };
}

async function install_main_loop_probe(
  application: ElectronApplication,
): Promise<void> {
  await application.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      exportSpikeLoopProbe?: {
        delays: number[];
        expected: number;
        timer: NodeJS.Timeout;
      };
    };
    if (state.exportSpikeLoopProbe)
      clearInterval(state.exportSpikeLoopProbe.timer);
    const delays: number[] = [];
    const expected = globalThis.performance.now() + 10;
    const callback = globalThis.eval(`() => {
      const probe = globalThis.exportSpikeLoopProbe;
      const now = globalThis.performance.now();
      probe.delays.push(Math.max(0, now - probe.expected));
      probe.expected = now + 10;
    }`) as () => void;
    const timer = setInterval(callback, 10);
    state.exportSpikeLoopProbe = { delays, expected, timer };
  });
}

async function take_main_loop_delays(
  application: ElectronApplication,
): Promise<number[]> {
  return application.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      exportSpikeLoopProbe?: { delays: number[] };
    };
    const delays = state.exportSpikeLoopProbe?.delays.splice(0) ?? [];
    return delays;
  });
}

async function create_response_window(
  application: ElectronApplication,
  base_url: string,
): Promise<number> {
  return application.evaluate(async ({ BrowserWindow }, url) => {
    const probe = new BrowserWindow({
      width: 1280,
      height: 720,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    await probe.loadURL(url);
    return probe.webContents.id;
  }, base_url);
}

function start_ui_probe(
  application: ElectronApplication,
  web_contents_id: number,
) {
  const samples: number[] = [];
  let stopped = false;
  let active = false;
  const timer = setInterval(() => {
    if (active || stopped) return;
    active = true;
    const started = performance.now();
    void application
      .evaluate(
        ({ webContents }, id) =>
          webContents.fromId(id)?.executeJavaScript("performance.now()", true),
        web_contents_id,
      )
      .then(() => samples.push(performance.now() - started))
      .catch(() => undefined)
      .finally(() => {
        active = false;
      });
  }, 50);
  return {
    samples,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function start_memory_probe(
  application: ElectronApplication,
  ffmpeg_pid: number | undefined,
) {
  let electron_peak_working_set_kb = 0;
  let ffmpeg_peak_working_set_bytes = 0;
  let active = false;
  const sample = async () => {
    if (active) return;
    active = true;
    try {
      electron_peak_working_set_kb = Math.max(
        electron_peak_working_set_kb,
        await electron_peak_memory(application),
      );
      if (ffmpeg_pid) {
        ffmpeg_peak_working_set_bytes = Math.max(
          ffmpeg_peak_working_set_bytes,
          await process_working_set(ffmpeg_pid),
        );
      }
    } catch {
      // A renderer or application crash is an expected fault-injection outcome.
    } finally {
      active = false;
    }
  };
  void sample();
  const timer = setInterval(() => void sample(), 500);
  return {
    values: () => ({
      electron_peak_working_set_kb,
      ffmpeg_peak_working_set_bytes,
    }),
    stop() {
      clearInterval(timer);
    },
  };
}

async function electron_peak_memory(
  application: ElectronApplication,
): Promise<number> {
  return application.evaluate(({ app }) => {
    let total = 0;
    for (const metric of app.getAppMetrics()) {
      total += metric.memory.workingSetSize;
    }
    return total;
  });
}

async function process_working_set(pid: number): Promise<number> {
  if (process.platform !== "win32") return 0;
  try {
    const { stdout } = await exec_file(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`],
      { windowsHide: true },
    );
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function write_with_backpressure(
  child: ChildProcessWithoutNullStreams,
  png: Buffer,
): Promise<{ backpressure: boolean; drain_ms: number; write_ms: number }> {
  const write_started = performance.now();
  const accepted = child.stdin.write(png);
  const write_ms = performance.now() - write_started;
  if (accepted) return { backpressure: false, drain_ms: 0, write_ms };
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.stdin.off("drain", on_drain);
      child.off("exit", on_exit);
      child.off("error", on_error);
    };
    const on_drain = () => {
      cleanup();
      resolve();
    };
    const on_exit = () => {
      cleanup();
      reject(new Error("ffmpeg exited before stdin drained"));
    };
    const on_error = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.stdin.once("drain", on_drain);
    child.once("exit", on_exit);
    child.once("error", on_error);
  });
  return {
    backpressure: true,
    drain_ms: performance.now() - started,
    write_ms,
  };
}

function start_ffmpeg(ffmpeg_path: string, output: string) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    String(VIDEO_FPS),
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
    String(FRAME_COUNT),
    output,
  ];
  const child = spawn(ffmpeg_path, args, { stdio: "pipe", windowsHide: true });
  let stderr = "";
  child.stdout.resume();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return { child, args, stderr: () => stderr };
}

async function wait_for_child(
  child: ChildProcessWithoutNullStreams,
): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return child.exitCode;
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

async function ffprobe(ffmpeg_path: string, output: string): Promise<unknown> {
  const executable = path.join(
    path.dirname(ffmpeg_path),
    `ffprobe${process.platform === "win32" ? ".exe" : ""}`,
  );
  const { stdout } = await exec_file(executable, [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames:format=duration",
    "-of",
    "json",
    output,
  ]);
  return JSON.parse(stdout);
}

async function reload_spike(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.documentElement.dataset.exportSpikeReady === "true",
  );
  await page.evaluate(() => document.fonts.ready);
}

async function run_sequence(options: {
  application: ElectronApplication;
  page: Page;
  cdp: CDPSession;
  response_window_id: number;
  backend: Backend;
  barrier: ExportSpikeBarrier;
  mode: SequenceMetric["mode"];
  repeat: number;
  frames: readonly number[];
  ffmpeg_path: string;
  artifact_dir: string;
  keep_artifact: boolean;
}): Promise<SequenceMetric> {
  const metric: SequenceMetric = {
    backend: options.backend,
    barrier: options.barrier,
    mode: options.mode,
    repeat: options.repeat,
    total_ms: 0,
    frames: [],
    errors: [],
    stdin_backpressure_count: 0,
    stdin_write_ms: [],
    stdin_drain_ms: [],
    main_loop_delay_ms: [],
    ui_probe_ms: [],
    electron_peak_working_set_kb: 0,
    ffmpeg_peak_working_set_bytes: 0,
  };
  await reload_spike(options.page);
  await take_main_loop_delays(options.application);
  const ui_probe = start_ui_probe(
    options.application,
    options.response_window_id,
  );
  let ffmpeg_process: ReturnType<typeof start_ffmpeg> | undefined;
  let artifact_path: string | undefined;
  if (options.mode === "ffmpeg") {
    artifact_path = path.join(
      options.artifact_dir,
      `${options.backend}-${options.repeat}.mp4`,
    );
    ffmpeg_process = start_ffmpeg(options.ffmpeg_path, artifact_path);
    metric.ffmpeg_args = ffmpeg_process.args;
  }
  const memory_probe = start_memory_probe(
    options.application,
    ffmpeg_process?.child.pid,
  );
  const started = performance.now();
  try {
    for (const frame of options.frames) {
      const ready = await set_frame(options.page, frame, options.barrier);
      assert.equal(ready.ready.frame, frame);
      const captured = await capture_frame(
        options.application,
        options.cdp,
        options.backend,
        frame,
        ready.elapsed_ms,
        options.mode === "correctness",
      );
      metric.frames.push(captured.metric);
      if (
        captured.metric.probe_frame !== null &&
        captured.metric.probe_frame !== frame
      ) {
        metric.errors.push(
          `expected probe ${frame}, captured ${captured.metric.probe_frame}`,
        );
      }
      if (ffmpeg_process) {
        const write = await write_with_backpressure(
          ffmpeg_process.child,
          captured.png,
        );
        metric.stdin_write_ms.push(write.write_ms);
        if (write.backpressure) metric.stdin_backpressure_count += 1;
        if (write.drain_ms > 0) metric.stdin_drain_ms.push(write.drain_ms);
      }
    }
    if (ffmpeg_process && artifact_path) {
      ffmpeg_process.child.stdin.end();
      const code = await wait_for_child(ffmpeg_process.child);
      if (code !== 0)
        throw new Error(`ffmpeg exited ${code}: ${ffmpeg_process.stderr()}`);
      metric.ffmpeg_stderr = ffmpeg_process.stderr();
      const png_hashes = metric.frames.map(({ png_bytes }) => png_bytes);
      assert.equal(png_hashes.length, options.frames.length);
      const contents = await import("node:fs/promises").then(({ readFile }) =>
        readFile(artifact_path),
      );
      metric.artifact = {
        path: path.relative(PROJECT_ROOT, artifact_path),
        sha256: hash(contents),
        bytes: contents.length,
        ffprobe: await ffprobe(options.ffmpeg_path, artifact_path),
      };
      if (!options.keep_artifact) await rm(artifact_path, { force: true });
    }
  } catch (error) {
    metric.errors.push(error_message(error));
    if (ffmpeg_process && ffmpeg_process.child.exitCode === null) {
      ffmpeg_process.child.stdin.destroy();
      ffmpeg_process.child.kill();
      await wait_for_child(ffmpeg_process.child).catch(() => undefined);
    }
    if (artifact_path && !options.keep_artifact)
      await rm(artifact_path, { force: true });
  } finally {
    metric.total_ms = performance.now() - started;
    ui_probe.stop();
    memory_probe.stop();
    const memory = memory_probe.values();
    metric.electron_peak_working_set_kb = memory.electron_peak_working_set_kb;
    metric.ffmpeg_peak_working_set_bytes = memory.ffmpeg_peak_working_set_bytes;
    metric.ui_probe_ms = ui_probe.samples;
    metric.main_loop_delay_ms = await take_main_loop_delays(
      options.application,
    );
  }
  return metric;
}

async function frame_terminal_hashes(
  application: ElectronApplication,
  page: Page,
  cdp: CDPSession,
  backend: Backend,
  barrier: ExportSpikeBarrier,
): Promise<string[]> {
  const hashes: string[] = [];
  for (const frame of [57, 58, 59]) {
    const ready = await set_frame(page, frame, barrier);
    await page
      .locator('[data-testid="export-spike-probe"]')
      .evaluate((node) => {
        (node as HTMLElement).style.display = "none";
      });
    const capture = await capture_frame(
      application,
      cdp,
      backend,
      frame,
      ready.elapsed_ms,
    );
    hashes.push(hash(capture.png));
    await page
      .locator('[data-testid="export-spike-probe"]')
      .evaluate((node) => {
        (node as HTMLElement).style.display = "";
      });
  }
  return hashes;
}

function aggregate(
  backend: Backend,
  barrier: ExportSpikeBarrier | null,
  correctness: SequenceMetric[],
  performance_runs: SequenceMetric[],
): BackendAggregate {
  const relevant = performance_runs.filter((run) => run.backend === backend);
  return {
    backend,
    correct:
      barrier !== null &&
      correctness
        .filter((run) => run.backend === backend && run.barrier === barrier)
        .every((run) => run.errors.length === 0) &&
      correctness.some(
        (run) => run.backend === backend && run.barrier === barrier,
      ) &&
      relevant.every((run) => run.errors.length === 0),
    screenshot_total_ms: relevant
      .filter(({ mode }) => mode === "screenshot")
      .map(({ total_ms }) => total_ms),
    ffmpeg_total_ms: relevant
      .filter(({ mode }) => mode === "ffmpeg")
      .map(({ total_ms }) => total_ms),
    ui_probe_ms: relevant.flatMap(({ ui_probe_ms }) => ui_probe_ms),
    main_loop_delay_ms: relevant.flatMap(
      ({ main_loop_delay_ms }) => main_loop_delay_ms,
    ),
  };
}

async function run_faults(
  application: ElectronApplication,
  page: Page,
  cdp: CDPSession,
  backend: Backend,
  barrier: ExportSpikeBarrier,
  ffmpeg_path: string,
  artifact_dir: string,
) {
  const results: Record<string, unknown> = {};
  for (const name of ["cancel", "encoder-crash"] as const) {
    const output = path.join(artifact_dir, `${name}.partial.mp4`);
    const process = start_ffmpeg(ffmpeg_path, output);
    let produced = 0;
    try {
      for (const frame of [0, 1, 2]) {
        const ready = await set_frame(page, frame, barrier);
        const capture = await capture_frame(
          application,
          cdp,
          backend,
          frame,
          ready.elapsed_ms,
        );
        await write_with_backpressure(process.child, capture.png);
        produced += 1;
      }
      process.child.stdin.destroy();
      process.child.kill();
      await wait_for_child(process.child);
      results[name] = {
        produced_before_stop: produced,
        exited:
          process.child.exitCode !== null || process.child.signalCode !== null,
        partial_removed: true,
      };
    } finally {
      if (process.child.exitCode === null) process.child.kill();
      await rm(output, { force: true });
    }
  }

  const crash_event = page.waitForEvent("crash");
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.getURL().includes("electron-export-spike")) {
        window.webContents.forcefullyCrashRenderer();
        break;
      }
    }
  });
  await crash_event;
  results.renderer_crash = { observed: true, frame_production_stopped: true };
  return results;
}

async function run_app_exit_cleanup(
  application: ElectronApplication,
  ffmpeg_path: string,
  artifact_dir: string,
) {
  const output = path.join(artifact_dir, "app-exit.partial.mp4");
  const process = start_ffmpeg(ffmpeg_path, output);
  await new Promise<void>((resolve, reject) => {
    process.child.once("spawn", resolve);
    process.child.once("error", reject);
  });
  await application.close();
  process.child.stdin.destroy();
  process.child.kill();
  await wait_for_child(process.child).catch(() => undefined);
  await rm(output, { force: true });
  return {
    coordinator: "external spike harness",
    electron_closed: true,
    ffmpeg_exited:
      process.child.exitCode !== null || process.child.signalCode !== null,
    partial_removed: true,
    remaining_working_set_bytes: await process_working_set(
      process.child.pid ?? 0,
    ),
  };
}

async function main() {
  const options = parse_args(process.argv.slice(2));
  const artifact_dir = path.join(PROJECT_ROOT, "tmp", "electron-export-spike");
  await mkdir(path.dirname(options.output), { recursive: true });
  await mkdir(artifact_dir, { recursive: true });
  const config_home = await mkdtemp(
    path.join(tmpdir(), "gachasimulate-export-spike-"),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout: ffmpeg_version } = await exec_file(options.ffmpeg, [
    "-hide_banner",
    "-version",
  ]);
  const { stdout: ffmpeg_encoders } = await exec_file(options.ffmpeg, [
    "-hide_banner",
    "-encoders",
  ]);
  assert.match(ffmpeg_encoders, /libx264/);

  let application: ElectronApplication | undefined;
  let cdp: CDPSession | undefined;
  const correctness: SequenceMetric[] = [];
  const warmups: SequenceMetric[] = [];
  const performance_runs: SequenceMetric[] = [];
  let faults: unknown = null;
  const terminal_hashes: Record<string, string[]> = {};
  const barrier_terminal_hashes: Partial<
    Record<ExportSpikeBarrier, Record<string, string[]>>
  > = {};
  let app_exit_cleanup: unknown = null;
  try {
    application = await electron.launch({
      args: [PROJECT_ROOT],
      cwd: PROJECT_ROOT,
      env: {
        ...env,
        GACHASIMULATE_ELECTRON_OFFSCREEN: "1",
        XDG_CONFIG_HOME: config_home,
      },
    });
    const page = await application.firstWindow();
    const base_url = page.url().replace(/[?#].*$/, "");
    cdp = await emulate_viewport(page, CANVAS_WIDTH, CANVAS_HEIGHT);
    await page.goto(`${base_url}?electron-export-spike=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => innerWidth === 3840 && innerHeight === 2160,
    );
    await page.waitForFunction(
      () => document.documentElement.dataset.exportSpikeReady === "true",
    );
    const response_window_id = await create_response_window(
      application,
      base_url,
    );
    const electron_environment = await application.evaluate(
      async ({ app, BrowserWindow, webContents }, response_id) => {
        let export_host: Electron.BrowserWindow | undefined;
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.webContents.getURL().includes("electron-export-spike")) {
            export_host = window;
            break;
          }
        }
        return {
          electron: globalThis.process.versions.electron,
          chrome: globalThis.process.versions.chrome,
          gpu: await app.getGPUInfo("complete"),
          export_host: {
            offscreen: export_host?.webContents.isOffscreen() ?? false,
            visible: export_host?.isVisible() ?? true,
            background_throttling:
              export_host?.webContents.getBackgroundThrottling() ?? true,
          },
          response_window: {
            offscreen: webContents.fromId(response_id)?.isOffscreen() ?? true,
            background_throttling:
              webContents.fromId(response_id)?.getBackgroundThrottling() ??
              true,
          },
        };
      },
      response_window_id,
    );
    await install_main_loop_probe(application);

    const correctness_repeats = options.quick ? 1 : 3;
    const correctness_frames = options.quick
      ? [0, 1, 30, 57, 58, 59]
      : Array.from({ length: FRAME_COUNT }, (_, frame) => frame);
    for (const barrier of BARRIERS) {
      for (const backend of BACKENDS) {
        warmups.push(
          await run_sequence({
            application,
            page,
            cdp,
            response_window_id,
            backend,
            barrier,
            mode: "correctness",
            repeat: -1,
            frames: [0, 30, 59],
            ffmpeg_path: options.ffmpeg,
            artifact_dir,
            keep_artifact: false,
          }),
        );
        for (let repeat = 0; repeat < correctness_repeats; repeat += 1) {
          correctness.push(
            await run_sequence({
              application,
              page,
              cdp,
              response_window_id,
              backend,
              barrier,
              mode: "correctness",
              repeat,
              frames: correctness_frames,
              ffmpeg_path: options.ffmpeg,
              artifact_dir,
              keep_artifact: false,
            }),
          );
        }
      }
      barrier_terminal_hashes[barrier] = {};
      for (const backend of BACKENDS) {
        barrier_terminal_hashes[barrier]![backend] =
          await frame_terminal_hashes(application, page, cdp, backend, barrier);
      }
    }

    const reliable_barriers = Object.fromEntries(
      BACKENDS.map((backend) => [
        backend,
        BARRIERS.find(
          (barrier) =>
            correctness
              .filter(
                (run) => run.barrier === barrier && run.backend === backend,
              )
              .every((run) => run.errors.length === 0) &&
            new Set(barrier_terminal_hashes[barrier]?.[backend] ?? []).size ===
              1,
        ) ?? null,
      ]),
    ) as Record<Backend, ExportSpikeBarrier | null>;
    if (Object.values(reliable_barriers).some((barrier) => barrier !== null)) {
      const performance_repeats = options.quick ? 1 : 5;
      for (const backend of BACKENDS) {
        const reliable_barrier = reliable_barriers[backend];
        if (!reliable_barrier) continue;
        terminal_hashes[backend] =
          barrier_terminal_hashes[reliable_barrier]?.[backend] ?? [];
        for (const mode of ["screenshot", "ffmpeg"] as const) {
          warmups.push(
            await run_sequence({
              application,
              page,
              cdp,
              response_window_id,
              backend,
              barrier: reliable_barrier,
              mode,
              repeat: -1,
              frames: [0, 30, 59],
              ffmpeg_path: options.ffmpeg,
              artifact_dir,
              keep_artifact: false,
            }),
          );
          for (let repeat = 0; repeat < performance_repeats; repeat += 1) {
            performance_runs.push(
              await run_sequence({
                application,
                page,
                cdp,
                response_window_id,
                backend,
                barrier: reliable_barrier,
                mode,
                repeat,
                frames: Array.from(
                  { length: FRAME_COUNT },
                  (_, frame) => frame,
                ),
                ffmpeg_path: options.ffmpeg,
                artifact_dir,
                keep_artifact: mode === "ffmpeg" && repeat === 0,
              }),
            );
          }
        }
      }
      const aggregates = BACKENDS.map((backend) =>
        aggregate(
          backend,
          reliable_barriers[backend],
          correctness,
          performance_runs,
        ),
      );
      const decision = select_backend(aggregates, THRESHOLDS);
      const lifecycle_backend =
        decision.backend ?? aggregates.find(({ correct }) => correct)?.backend;
      if (lifecycle_backend) {
        faults = await run_faults(
          application,
          page,
          cdp,
          lifecycle_backend,
          reliable_barriers[lifecycle_backend]!,
          options.ffmpeg,
          artifact_dir,
        );
        app_exit_cleanup = await run_app_exit_cleanup(
          application,
          options.ffmpeg,
          artifact_dir,
        );
        application = undefined;
      }

      const report = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        quick: options.quick,
        environment: {
          platform: process.platform,
          arch: process.arch,
          os_release: release(),
          cpu: cpus()[0]?.model ?? "unknown",
          cpu_count: cpus().length,
          total_memory_bytes: totalmem(),
          node: process.version,
          ...electron_environment,
          playwright:
            process.env.npm_package_devDependencies_playwright ?? "1.61.0",
          ffmpeg_path: path.resolve(options.ffmpeg),
          ffmpeg_version: ffmpeg_version.trim(),
          ffmpeg_sha256: hash(
            await import("node:fs/promises").then(({ readFile }) =>
              readFile(options.ffmpeg),
            ),
          ),
        },
        thresholds: THRESHOLDS,
        method: {
          canvas: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
          frames: FRAME_COUNT,
          fps: VIDEO_FPS,
          correctness_repeats,
          performance_repeats,
          barriers: BARRIERS,
        },
        reliable_barriers,
        reliable_barrier: decision.backend
          ? reliable_barriers[decision.backend]
          : null,
        warmups,
        correctness,
        barrier_terminal_hashes,
        terminal_hashes,
        performance_runs,
        aggregates,
        decision,
        faults,
        app_exit_cleanup,
      };
      await writeFile(
        options.output,
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      );
      console.log(options.output);
      console.log(JSON.stringify({ reliable_barriers, decision }, null, 2));
    } else {
      const report = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        quick: options.quick,
        environment: {
          platform: process.platform,
          arch: process.arch,
          ffmpeg_version: ffmpeg_version.trim(),
        },
        thresholds: THRESHOLDS,
        reliable_barriers,
        reliable_barrier: null,
        warmups,
        correctness,
        barrier_terminal_hashes,
        decision: {
          backend: null,
          reason: "no frame-ready barrier was reliable for either backend",
        },
      };
      await writeFile(
        options.output,
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      );
      console.log(options.output);
    }
  } finally {
    try {
      await cdp?.detach().catch(() => undefined);
    } finally {
      try {
        await application?.close().catch(() => undefined);
        app_exit_cleanup = { electron_closed: true };
      } finally {
        await rm(config_home, { force: true, recursive: true });
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error_message(error));
  process.exitCode = 1;
});
