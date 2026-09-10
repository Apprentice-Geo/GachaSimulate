import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, ipcMain } from "electron";
import type { SpawnOptions } from "node:child_process";
import type { DesktopExportEvent, ExportStage } from "../shared/export_task";
import type { DesktopSimulationEvent } from "../shared/simulation";
import {
  EXPORT_FRAME_COUNT,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  ExportHost,
  png_dimensions,
} from "../main/export_host";
import { ExportTaskCoordinator } from "../main/export_task";
import { ResultEditor } from "../main/result_editor";
import { UserRequestAdmission } from "../main/request_admission";
import { SimulationTask } from "../main/simulation";

type Scenario = "idle" | "simulation" | "analysis";
type RunKind = "warmup" | "measurement" | "cancellation";
type Input = {
  project_root: string;
  output_dir: string;
  quick: boolean;
  repetitions: number;
  warmups: number;
  background_target_ms: number;
  sample_interval_ms: number;
  run_timeout_ms: number;
  seed_runs: number;
  export_html: string;
  export_preload: string;
  desktop_html: string;
  desktop_preload: string;
  ffprobe: string;
};
type TimedEvent = { at_ms: number; event: DesktopExportEvent };
type MemorySample = {
  at_ms: number;
  electron_bytes: number;
  ffmpeg_bytes: number;
  core_bytes: number;
  analyzer_bytes: number;
  total_bytes: number;
  system_available_bytes: number;
  complete: boolean;
};
type Calibration = {
  simulation_runs: number;
  analysis_runs: number;
  analysis_gsr: string;
  attempts: Array<{
    kind: "simulation" | "analysis";
    runs: number;
    elapsed_ms: number;
    gsr_bytes: number;
    peak_native_bytes: number;
    reached_target: boolean;
  }>;
};

declare global {
  var __electronExportPerformancePromise: Promise<unknown> | undefined;
}

const parsed_input = JSON.parse(
  process.env.GACHASIMULATE_EXPORT_PERFORMANCE_INPUT ?? "null",
) as Input | null;
if (!parsed_input) throw new Error("missing performance harness input");
const input: Input = parsed_input;
const exec_file = promisify(execFile);
const processes = {
  ffmpeg: new Set<number>(),
  core: new Set<number>(),
  analyzer: new Set<number>(),
};
const now = () => performance.timeOrigin + performance.now();

function tracked_spawn(group: keyof typeof processes) {
  return (command: string, args: readonly string[], options: SpawnOptions) => {
    const child = spawn(command, args, options);
    if (child.pid) processes[group].add(child.pid);
    child.once("close", () => {
      if (child.pid) processes[group].delete(child.pid);
    });
    return child;
  };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function working_sets(groups: Record<string, number[]>) {
  const ids = [...new Set(Object.values(groups).flat())].filter(alive);
  const totals = Object.fromEntries(Object.keys(groups).map((key) => [key, 0]));
  if (!ids.length) return totals;
  const script = `$ErrorActionPreference='SilentlyContinue';$ids=@(${ids.join(",")});Get-Process -Id $ids|%{"$($_.Id),$($_.WorkingSet64)"};exit 0`;
  const { stdout } = await exec_file(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 5_000, windowsHide: true },
  );
  const values = new Map<number, number>();
  for (const line of stdout.trim().split(/\r?\n/)) {
    const [pid, bytes] = line.split(",").map(Number);
    if (Number.isSafeInteger(pid) && Number.isFinite(bytes))
      values.set(pid, bytes);
  }
  for (const [group, pids] of Object.entries(groups))
    totals[group] = pids.reduce((sum, pid) => sum + (values.get(pid) ?? 0), 0);
  return totals;
}

async function sample_memory(): Promise<MemorySample> {
  const at_ms = now();
  const electron_bytes = app
    .getAppMetrics()
    .reduce((sum, metric) => sum + metric.memory.workingSetSize * 1024, 0);
  const groups = Object.fromEntries(
    Object.entries(processes).map(([name, values]) => [name, [...values]]),
  );
  let external: Record<string, number>;
  let complete = true;
  try {
    external = await working_sets(groups);
  } catch {
    complete = false;
    external = { ffmpeg: 0, core: 0, analyzer: 0 };
  }
  return {
    at_ms,
    electron_bytes,
    ffmpeg_bytes: external.ffmpeg,
    core_bytes: external.core,
    analyzer_bytes: external.analyzer,
    total_bytes:
      electron_bytes + external.ffmpeg + external.core + external.analyzer,
    system_available_bytes: freemem(),
    complete,
  };
}

function deferred<T>() {
  let resolve_promise!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve_promise = done));
  return { promise, resolve: resolve_promise };
}

async function simulation(runs: number, directory: string) {
  mkdirSync(directory, { recursive: true });
  const running = deferred<void>();
  const completed = deferred<{ ended_ms: number; path: string | null }>();
  let running_ms = 0;
  const task = new SimulationTask(
    resolve(input.project_root, "test-fixtures/configs/presets"),
    directory,
    (message: DesktopSimulationEvent) => {
      if (
        !running_ms &&
        message.event?.type === "stage" &&
        message.event.stage === "simulating"
      ) {
        running_ms = now();
        running.resolve();
      }
      if (["completed", "cancelled", "failed"].includes(message.status))
        completed.resolve({
          ended_ms: now(),
          path:
            message.event?.type === "completed"
              ? message.event.result_path
              : null,
        });
    },
    {
      local_dir: () =>
        resolve(input.project_root, "test-fixtures/configs/presets"),
      native_dir: resolve(input.project_root, "build/native/bin"),
      spawn: tracked_spawn("core") as never,
    },
  );
  const started_ms = now();
  task.start({
    configSource: "local",
    configId: "basic_probability",
    termination: "termination.yaml",
    resultItem: "draw_count",
    target: { kind: "totalRuns", value: runs },
    seed: 20260910,
    threads: cpus().length,
  });
  await Promise.race([
    running.promise,
    completed.promise.then(() => {
      throw new Error("simulation ended before simulating stage");
    }),
  ]);
  return { task, started_ms, running_ms, completed: completed.promise };
}

async function create_gsr(runs: number, directory: string) {
  const operation = await simulation(runs, directory);
  const outcome = await operation.completed;
  if (!outcome.path) throw new Error("fixture simulation failed");
  return outcome.path;
}

async function observe_native<T>(
  operation: Promise<T>,
  group: "core" | "analyzer",
): Promise<{ value: T; peak_bytes: number }> {
  let peak_bytes = 0;
  let finished = false;
  const poll = async () => {
    if (finished) return;
    const value = await sample_memory();
    peak_bytes = Math.max(
      peak_bytes,
      group === "core" ? value.core_bytes : value.analyzer_bytes,
    );
  };
  const timer = setInterval(() => void poll(), input.sample_interval_ms);
  try {
    const value = await operation;
    await poll();
    return { value, peak_bytes };
  } finally {
    finished = true;
    clearInterval(timer);
  }
}

async function analysis(path: string) {
  const editor = new ResultEditor({
    native_dir: resolve(input.project_root, "build/native/bin"),
    spawn: tracked_spawn("analyzer") as never,
  });
  const started_ms = now();
  const completed = editor.open(path).then(
    () => ({ ended_ms: now(), error: null as string | null }),
    (reason: unknown) => ({
      ended_ms: now(),
      error: reason instanceof Error ? reason.message : String(reason),
    }),
  );
  const deadline = Date.now() + 5_000;
  while (!editor.active && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 5));
  if (!editor.active) throw new Error("analyzer did not start");
  return { editor, started_ms, completed };
}

async function calibrate(root: string): Promise<Calibration> {
  const attempts: Calibration["attempts"] = [];
  const target = input.background_target_ms;
  const run_cap = Math.max(
    input.seed_runs,
    Math.min(1_000_000_007, Math.floor((totalmem() * 0.25) / 16)),
  );
  let simulation_runs = input.seed_runs;
  let gsr: string;
  while (true) {
    const started = now();
    const observed = await observe_native(
      create_gsr(
        simulation_runs,
        join(root, `calibration-simulation-${simulation_runs}`),
      ),
      "core",
    );
    gsr = observed.value;
    const elapsed_ms = now() - started;
    attempts.push({
      kind: "simulation",
      runs: simulation_runs,
      elapsed_ms,
      gsr_bytes: statSync(gsr).size,
      peak_native_bytes: observed.peak_bytes,
      reached_target: elapsed_ms >= target,
    });
    if (observed.peak_bytes > totalmem() * 0.25)
      throw new Error("simulation calibration exceeded 25% of physical memory");
    if (elapsed_ms >= target || simulation_runs >= run_cap) break;
    simulation_runs = Math.min(
      run_cap,
      simulation_runs *
        Math.max(2, Math.ceil((target / Math.max(1, elapsed_ms)) * 1.15)),
    );
  }
  let analysis_runs = simulation_runs;
  let analysis_gsr = gsr;
  while (true) {
    const operation = await analysis(analysis_gsr);
    const observed = await observe_native(operation.completed, "analyzer");
    const outcome = observed.value;
    if (outcome.error)
      throw new Error(`analysis calibration failed: ${outcome.error}`);
    const elapsed_ms = outcome.ended_ms - operation.started_ms;
    attempts.push({
      kind: "analysis",
      runs: analysis_runs,
      elapsed_ms,
      gsr_bytes: statSync(analysis_gsr).size,
      peak_native_bytes: observed.peak_bytes,
      reached_target: elapsed_ms >= target,
    });
    if (observed.peak_bytes > totalmem() * 0.25)
      throw new Error("analysis calibration exceeded 25% of physical memory");
    if (elapsed_ms >= target || analysis_runs >= run_cap) break;
    analysis_runs = Math.min(
      run_cap,
      analysis_runs *
        Math.max(2, Math.ceil((target / Math.max(1, elapsed_ms)) * 1.15)),
    );
    analysis_gsr = await create_gsr(
      analysis_runs,
      join(root, `calibration-analysis-${analysis_runs}`),
    );
  }
  return { simulation_runs, analysis_runs, analysis_gsr, attempts };
}

async function install_renderer_probe(window: BrowserWindow) {
  await window.webContents.executeJavaScript(String.raw`
    (() => {
      const state = {events: [], delays: []};
      Object.defineProperty(window, "__gachaExportPerformance", {value: state});
      window.desktopApi.onExportEvent((event) => state.events.push({
        at_ms: performance.timeOrigin + performance.now(), event
      }));
      let expected = performance.now() + 50;
      setInterval(() => {
        const current = performance.now();
        state.delays.push(Math.max(0, current - expected));
        expected = current + 50;
      }, 50);
    })()
  `);
}

async function renderer_metrics(window: BrowserWindow) {
  return window.webContents.executeJavaScript(String.raw`
    (() => ({
      events: window.__gachaExportPerformance.events,
      delays: window.__gachaExportPerformance.delays
    }))()
  `) as Promise<{ events: TimedEvent[]; delays: number[] }>;
}

function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

function phases(events: TimedEvent[]): Partial<Record<ExportStage, number>> {
  const started = events.find((item) => item.event.type === "started")?.at_ms;
  const ended = events.find((item) =>
    ["completed", "cancelled", "failed"].includes(item.event.type),
  )?.at_ms;
  if (started === undefined || ended === undefined) return {};
  const rendering = events.find(
    (item) =>
      item.event.type === "progress" && item.event.stage === "rendering",
  )?.at_ms;
  const finalizing = events.find(
    (item) =>
      item.event.type === "progress" && item.event.stage === "finalizing",
  )?.at_ms;
  return {
    preparing: (rendering ?? ended) - started,
    ...(rendering === undefined
      ? {}
      : { rendering: (finalizing ?? ended) - rendering }),
    ...(finalizing === undefined ? {} : { finalizing: ended - finalizing }),
  };
}

async function verify_artifacts(directory: string) {
  const base = join(directory, "electron-export-performance");
  const png = `${base}.png`;
  const mp4 = `${base}.mp4`;
  const dimensions = png_dimensions(readFileSync(png));
  if (dimensions.width !== EXPORT_WIDTH || dimensions.height !== EXPORT_HEIGHT)
    throw new Error(`unexpected PNG dimensions: ${JSON.stringify(dimensions)}`);
  const { stdout } = await exec_file(input.ffprobe, [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames",
    "-of",
    "json",
    mp4,
  ]);
  const streams =
    (JSON.parse(stdout) as { streams?: Array<Record<string, unknown>> })
      .streams ?? [];
  const video = streams.filter((stream) => stream.codec_type === "video");
  if (
    video.length !== 1 ||
    streams.some((stream) => stream.codec_type === "audio") ||
    video[0].codec_name !== "h264" ||
    video[0].width !== EXPORT_WIDTH ||
    video[0].height !== EXPORT_HEIGHT ||
    video[0].pix_fmt !== "yuv420p" ||
    video[0].r_frame_rate !== "60/1" ||
    video[0].nb_read_frames !== String(EXPORT_FRAME_COUNT)
  )
    throw new Error(`unexpected MP4 streams: ${JSON.stringify(streams)}`);
  return [png, mp4].map((path) => ({
    name: path.slice(directory.length + 1),
    bytes: statSync(path).size,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  }));
}

function residuals(directory: string) {
  return readdirSync(directory).filter((name) =>
    /\.(?:partial|backup)\.(?:png|mp4)$/.test(name),
  );
}

async function export_run(
  scenario: Scenario,
  kind: RunKind,
  sequence: number,
  editor: ResultEditor,
  session_id: string,
  desktop: BrowserWindow,
  calibration: Calibration,
  root: string,
) {
  const directory = join(
    root,
    `run-${String(sequence).padStart(2, "0")}-${kind}-${scenario}`,
  );
  mkdirSync(directory, { recursive: true });
  let background_start = 0;
  let background_end = Number.POSITIVE_INFINITY;
  let stop_background: (() => Promise<void>) | null = null;
  let background_done: Promise<void> = Promise.resolve();
  if (scenario === "simulation") {
    const operation = await simulation(
      calibration.simulation_runs,
      join(directory, "simulation"),
    );
    background_start = operation.running_ms;
    background_done = operation.completed.then((outcome) => {
      background_end = outcome.ended_ms;
    });
    stop_background = () => operation.task.cancel();
  } else if (scenario === "analysis") {
    const operation = await analysis(calibration.analysis_gsr);
    background_start = operation.started_ms;
    background_done = operation.completed.then((outcome) => {
      background_end = outcome.ended_ms;
      if (outcome.error) throw new Error(outcome.error);
    });
    stop_background = () => operation.editor.cancel();
  }

  const before = await renderer_metrics(desktop);
  const event_offset = before.events.length;
  const delay_offset = before.delays.length;
  const main_events: TimedEvent[] = [];
  const ready = deferred<void>();
  const started = deferred<void>();
  const rendering = deferred<void>();
  const terminal = deferred<DesktopExportEvent>();
  let task_id = "";
  const coordinator = new ExportTaskCoordinator(
    editor,
    new UserRequestAdmission(),
    (event) => {
      main_events.push({ at_ms: now(), event });
      desktop.webContents.send("export-event", event);
      if (event.type === "preparation-ready") ready.resolve();
      if (event.type === "started") {
        task_id = event.task_id;
        started.resolve();
      }
      if (event.type === "progress" && event.stage === "rendering")
        rendering.resolve();
      if (["completed", "cancelled", "failed"].includes(event.type))
        terminal.resolve(event);
    },
    {
      host_factory: (request) =>
        new ExportHost(request, {
          export_html_path: input.export_html,
          packaged: false,
          preload_path: input.export_preload,
          spawn: tracked_spawn("ffmpeg") as never,
        }),
    },
  );
  const reservation = coordinator.prepare({
    session_id,
    formats: ["mp4", "png"],
    base_name: "electron-export-performance",
  });
  await ready.promise;
  const baseline = await sample_memory();
  const selection = await coordinator.select_destination(
    { reservation_id: reservation.reservation_id },
    async () => directory,
  );
  if (selection.status !== "started")
    throw new Error(`unexpected destination status: ${selection.status}`);
  await started.promise;
  const samples: MemorySample[] = [];
  let sampling = false;
  const take_sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      samples.push(await sample_memory());
    } finally {
      sampling = false;
    }
  };
  const timer = setInterval(() => void take_sample(), input.sample_interval_ms);
  let cancel_requested: number | null = null;
  if (kind === "cancellation") {
    await Promise.race([
      rendering.promise,
      new Promise<never>((_done, reject) =>
        setTimeout(
          () => reject(new Error("rendering start timed out")),
          30_000,
        ),
      ),
    ]);
    cancel_requested = now();
    void coordinator.cancel({ task_id }).catch(() => undefined);
  }
  const terminal_event = await Promise.race([
    terminal.promise,
    new Promise<never>((_done, reject) =>
      setTimeout(
        () => reject(new Error("export run timed out")),
        input.run_timeout_ms,
      ),
    ),
  ]);
  clearInterval(timer);
  while (sampling) await new Promise((done) => setTimeout(done, 10));
  await take_sample();
  const started_at = main_events.find(
    (item) => item.event.type === "started",
  )!.at_ms;
  const terminal_at = main_events.find((item) =>
    ["completed", "cancelled", "failed"].includes(item.event.type),
  )!.at_ms;
  if (stop_background) await stop_background().catch(() => undefined);
  await background_done.catch(() => undefined);
  await new Promise((done) => setTimeout(done, 100));
  const after = await renderer_metrics(desktop);
  const events = after.events.slice(event_offset);
  const timer_delays_ms = after.delays.slice(delay_offset);
  const relevant = events.filter((item) =>
    [
      "started",
      "progress",
      "heartbeat",
      "cancelling",
      "completed",
      "cancelled",
      "failed",
    ].includes(item.event.type),
  );
  const gaps = relevant
    .slice(1)
    .map((item, index) => item.at_ms - relevant[index].at_ms);
  const cancelling = relevant.find((item) => item.event.type === "cancelling");
  const cancel_ack_ms =
    cancel_requested === null || !cancelling
      ? null
      : cancelling.at_ms - cancel_requested;
  const elapsed_ms = terminal_at - started_at;
  const overlap_ms =
    scenario === "idle"
      ? 0
      : Math.max(
          0,
          Math.min(terminal_at, background_end) -
            Math.max(started_at, background_start),
        );
  const invalid_reasons: string[] = [];
  if (kind === "cancellation") {
    if (terminal_event.type !== "cancelled")
      invalid_reasons.push("cancellation did not end as cancelled");
    if (cancel_ack_ms === null)
      invalid_reasons.push("renderer did not receive cancelling");
  } else if (terminal_event.type !== "completed") {
    invalid_reasons.push("export did not complete");
  }
  if (scenario !== "idle" && overlap_ms <= 0)
    invalid_reasons.push("background task did not overlap export");
  if (
    !baseline.complete ||
    samples.length < 1 ||
    samples.some((item) => !item.complete)
  )
    invalid_reasons.push("memory sampling is incomplete");
  const leftover_files = residuals(directory);
  if (leftover_files.length)
    invalid_reasons.push("partial or backup files remain");
  if (BrowserWindow.getAllWindows().some((window) => window !== desktop))
    invalid_reasons.push("hidden export window remains");
  if ([...processes.ffmpeg].some(alive))
    invalid_reasons.push("FFmpeg process remains");
  if ([...processes.core, ...processes.analyzer].some(alive))
    invalid_reasons.push("native process remains");
  let artifacts: Awaited<ReturnType<typeof verify_artifacts>> = [];
  if (kind !== "cancellation" && terminal_event.type === "completed") {
    try {
      artifacts = await verify_artifacts(directory);
    } catch (reason) {
      invalid_reasons.push(
        `artifact validation failed: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }
  const peak_total_bytes = Math.max(
    baseline.total_bytes,
    ...samples.map((item) => item.total_bytes),
  );
  const result = {
    scenario,
    kind,
    sequence,
    valid: invalid_reasons.length === 0,
    invalid_reasons,
    task_id,
    terminal: terminal_event,
    elapsed_ms,
    phase_ms: phases(events),
    event_max_gap_ms: gaps.length ? Math.max(...gaps) : null,
    timer_delay_p95_ms: percentile(timer_delays_ms, 95),
    timer_delay_max_ms: timer_delays_ms.length
      ? Math.max(...timer_delays_ms)
      : null,
    cancel_ack_ms,
    overlap_ms,
    overlap_ratio:
      scenario === "idle" || elapsed_ms <= 0 ? 0 : overlap_ms / elapsed_ms,
    events,
    timer_delays_ms,
    memory: {
      baseline,
      samples,
      peak_total_bytes,
      peak_increment_bytes: peak_total_bytes - baseline.total_bytes,
      minimum_available_bytes: samples.length
        ? Math.min(...samples.map((item) => item.system_available_bytes))
        : null,
    },
    artifacts,
    residuals: leftover_files,
  };
  writeFileSync(
    join(
      input.output_dir,
      `run-${String(sequence).padStart(2, "0")}-${kind}-${scenario}.json`,
    ),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

function desktop_handlers() {
  ipcMain.handle("list-configs", () => []);
  ipcMain.handle("get-config-repository-state", () => ({
    status: "idle",
    configs: [],
  }));
  ipcMain.handle("get-logical-cpu-count", () => cpus().length);
}

async function main() {
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  await app.whenReady();
  desktop_handlers();
  const desktop = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: input.desktop_preload,
      contextIsolation: true,
      sandbox: true,
    },
  });
  await desktop.loadFile(input.desktop_html);
  await install_renderer_probe(desktop);
  const root = join(input.output_dir, "workspace");
  mkdirSync(root, { recursive: true });
  const seed_gsr = await create_gsr(
    input.quick ? 10_000 : input.seed_runs,
    join(root, "seed"),
  );
  const editor = new ResultEditor({
    native_dir: resolve(input.project_root, "build/native/bin"),
    spawn: tracked_spawn("analyzer") as never,
  });
  const current = await editor.open(seed_gsr);
  const calibration = await calibrate(root);
  const scenarios: Scenario[] = ["idle", "simulation", "analysis"];
  const schedule: Array<{ scenario: Scenario; kind: RunKind }> = [];
  for (let warmup = 0; warmup < input.warmups; warmup += 1)
    for (const scenario of scenarios)
      schedule.push({ scenario, kind: "warmup" });
  for (let round = 0; round < input.repetitions; round += 1)
    for (let index = 0; index < scenarios.length; index += 1)
      schedule.push({
        scenario: scenarios[(index + round) % scenarios.length],
        kind: "measurement",
      });
  for (const scenario of scenarios)
    schedule.push({ scenario, kind: "cancellation" });
  const runs = [];
  for (let index = 0; index < schedule.length; index += 1) {
    const item = schedule[index];
    runs.push(
      await export_run(
        item.scenario,
        item.kind,
        index + 1,
        editor,
        current.session_id,
        desktop,
        calibration,
        root,
      ),
    );
  }
  desktop.destroy();
  return {
    versions: process.versions,
    calibration,
    runs,
    physical_memory_bytes: totalmem(),
    logical_cpu_count: cpus().length,
  };
}

globalThis.__electronExportPerformancePromise = main()
  .catch((reason: unknown) => {
    writeFileSync(
      join(input.output_dir, "harness-failure.json"),
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          message: reason instanceof Error ? reason.message : String(reason),
          stack: reason instanceof Error ? reason.stack : undefined,
        },
        null,
        2,
      )}\n`,
    );
    throw reason;
  })
  .finally(() => app.quit());
