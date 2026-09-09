import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import analysis_fixture from "../visualize/fixtures/example_analysis.json";
import display_fixture from "../visualize/fixtures/example_display.json";
import { validate_analysis } from "../visualize/data/analysis";
import { validate_display_config } from "../visualize/data/validate_display_config";
import { build_cdf_view_model } from "../visualize/view/cdf_view_model";
import {
  EXPORT_FRAME_COUNT,
  EXPORT_HEIGHT,
  EXPORT_PNG_FRAME,
  EXPORT_WIDTH,
  png_dimensions,
  resolve_ffmpeg_executable,
} from "../main/export_host";

const exec_file = promisify(execFile);
const project_root = process.cwd();
const require_integration =
  process.env.GACHASIMULATE_REQUIRE_EXPORT_HOST_INTEGRATION === "1";

interface HarnessResult {
  png_only: boolean;
  png_frames: number[];
  mp4_frames: number[];
  terminal_hashes: string[];
  cancel_frames: number[];
  cancelled: boolean;
  ffmpeg_crashed: boolean;
  ffmpeg_crash_closed: boolean;
  renderer_crashed: boolean;
}

function skip_or_throw(reason: string): never | void {
  if (require_integration) throw new Error(reason);
  console.log(`SKIP export host integration: ${reason}`);
}

function harness_source(): string {
  return String.raw`
const { createHash } = require("node:crypto");
const { spawn: nodeSpawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { readdir, readFile, rename, writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { app, BrowserWindow, nativeImage } = require("electron");

const input = JSON.parse(process.env.GACHASIMULATE_EXPORT_INTEGRATION_INPUT);
const writeExitReady = async (state) => {
  const temporary = input.exit_ready + ".tmp";
  await writeFile(temporary, JSON.stringify(state));
  await rename(temporary, input.exit_ready);
};
const progress = (stage) => writeFileSync(input.progress_file, stage);
progress("harness-loaded");
const projectRequire = createRequire(input.project_package);
projectRequire("tsx/cjs");
const { ExportHost } = projectRequire(input.export_host_source);
progress("export-host-loaded");

app.commandLine.appendSwitch("force-device-scale-factor", "1");

function inspect_probe(png, expected_frame) {
  const image = nativeImage.createFromBuffer(png);
  const size = image.getSize();
  if (size.width !== 3840 || size.height !== 2160)
    throw new Error("nativeImage decoded an unexpected frame size");
  const bitmap = image.toBitmap();
  const pixel = (x, y) => {
    const offset = (y * size.width + x) * 4;
    return [bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]];
  };
  const start = pixel(4, 4);
  const end = pixel(76, 4);
  if (start[0] < 250 || start[1] > 5 || start[2] < 250)
    throw new Error("export frame probe start sentinel is absent: " + JSON.stringify({ start, end }));
  if (end[0] < 250 || end[1] < 250 || end[2] > 5)
    throw new Error("export frame probe end sentinel is absent");
  let decoded = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    const value = pixel(12 + bit * 8, 4);
    if (value[0] + value[1] + value[2] > 500) decoded |= 1 << bit;
  }
  if (decoded !== expected_frame)
    throw new Error("expected frame probe " + expected_frame + ", got " + decoded);
  for (let y = 0; y < 8; y += 1) {
    bitmap.fill(0, y * size.width * 4, (y * size.width + 80) * 4);
  }
  return createHash("sha256").update(bitmap).digest("hex");
}

globalThis.exportHostIntegrationPromise = app.whenReady().then(async () => {
  progress("app-ready");
  // Production always keeps the desktop window alive while an ExportHost
  // creates and destroys its private offscreen window. Mirror that lifecycle
  // so sequential host checks do not close the harness's last window.
  const desktop_window = new BrowserWindow({ show: false });
  progress("desktop-window-created");
  const base_dependencies = {
    export_html_path: input.export_html,
    packaged: false,
    preload_path: input.export_preload,
    protocol_timeout_ms: 30000,
  };
  if (input.exit_mode) {
    let ffmpeg_pid = 0;
    const never = new Promise(() => undefined);
    const host = new ExportHost(
      {
        job_id: "integration-app-exit",
        formats: ["mp4"],
        view_model: input.view_model,
        destinations: { mp4: input.exit_output },
      },
      {
        ...base_dependencies,
        spawn(command, args, options) {
          const child = nodeSpawn(command, args, options);
          ffmpeg_pid = child.pid || 0;
          return child;
        },
        async verify_frame_probe(buffer, frame) {
          inspect_probe(buffer, frame);
          await writeExitReady({ ffmpeg_pid, frame });
          await never;
        },
      },
    );
    globalThis.exitExportHost = host;
    let exit_cleanup_started = false;
    app.on("before-quit", (event) => {
      if (!host.active) return;
      event.preventDefault();
      if (exit_cleanup_started) return;
      exit_cleanup_started = true;
      void host.dispose().finally(() => app.quit());
    });
    progress("exit-host-starting");
    void host.start().catch((error) =>
      writeExitReady({ error: String(error && error.message) }),
    );
    return { exit_mode: true };
  }
  const png_frames = [];
  const png = new ExportHost(
    {
      job_id: "integration-png",
      formats: ["png"],
      view_model: input.view_model,
      destinations: { png: input.png_output },
    },
    {
      ...base_dependencies,
      verify_frame_probe(buffer, frame) {
        progress("png-frame-" + frame);
        inspect_probe(buffer, frame);
        png_frames.push(frame);
      },
    },
  );
  progress("png-starting");
  await png.start();
  progress("png-complete");

  if (input.png_only) {
    return {
      png_only: true,
      png_frames,
      mp4_frames: [],
      terminal_hashes: [],
      cancel_frames: [],
      cancelled: false,
      ffmpeg_crashed: false,
      ffmpeg_crash_closed: false,
      renderer_crashed: false,
    };
  }

  const mp4_frames = [];
  const terminal_hashes = [];
  const mp4 = new ExportHost(
    {
      job_id: "integration-dual",
      formats: ["mp4", "png"],
      view_model: input.view_model,
      destinations: {
        mp4: input.mp4_output,
        png: input.dual_png_output,
      },
    },
    {
      ...base_dependencies,
      verify_frame_probe(buffer, frame) {
        const hash = inspect_probe(buffer, frame);
        mp4_frames.push(frame);
        if (frame >= 57) terminal_hashes.push(hash);
      },
    },
  );
  await mp4.start();

  await writeFile(input.ffmpeg_crash_output, "old-video");
  let ffmpeg_crash_closed = false;
  const ffmpeg_crash = new ExportHost(
    {
      job_id: "integration-ffmpeg-crash",
      formats: ["mp4"],
      view_model: input.view_model,
      destinations: { mp4: input.ffmpeg_crash_output },
    },
    {
      ...base_dependencies,
      spawn(command, args, options) {
        const child = nodeSpawn(command, args, options);
        child.once("close", () => { ffmpeg_crash_closed = true; });
        child.once("spawn", () => setTimeout(() => child.kill("SIGKILL"), 10));
        return child;
      },
    },
  );
  let ffmpeg_crashed = false;
  try {
    await ffmpeg_crash.start();
  } catch (error) {
    ffmpeg_crashed = /FFmpeg/.test(String(error && error.message));
  }
  if ((await readFile(input.ffmpeg_crash_output, "utf8")) !== "old-video")
    throw new Error("FFmpeg crash damaged the previous destination");

  await writeFile(input.renderer_crash_output, "old-video");
  const renderer_crash = new ExportHost(
    {
      job_id: "integration-renderer-crash",
      formats: ["mp4"],
      view_model: input.view_model,
      destinations: { mp4: input.renderer_crash_output },
    },
    {
      ...base_dependencies,
      verify_frame_probe(buffer, frame) {
        inspect_probe(buffer, frame);
        const renderer = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().includes("export.html"),
        );
        if (!renderer) throw new Error("renderer crash target is absent");
        renderer.webContents.forcefullyCrashRenderer();
      },
    },
  );
  let renderer_crashed = false;
  try {
    await renderer_crash.start();
  } catch (error) {
    renderer_crashed = /renderer|destroyed|Render frame/.test(
      String(error && error.message),
    );
  }
  if ((await readFile(input.renderer_crash_output, "utf8")) !== "old-video")
    throw new Error("renderer crash damaged the previous destination");

  const cancel_frames = [];
  let reached_frame;
  const reached = new Promise((resolve) => { reached_frame = resolve; });
  const never = new Promise(() => undefined);
  const cancel = new ExportHost(
    {
      job_id: "integration-cancel",
      formats: ["mp4"],
      view_model: input.view_model,
      destinations: { mp4: input.cancel_output },
    },
    {
      ...base_dependencies,
      async verify_frame_probe(buffer, frame) {
        inspect_probe(buffer, frame);
        cancel_frames.push(frame);
        reached_frame();
        await never;
      },
    },
  );
  const running = cancel.start();
  await reached;
  await cancel.cancel();
  let cancelled = false;
  try {
    await running;
  } catch (error) {
    cancelled = /export cancelled/.test(String(error && error.message));
  }
  const leftovers = (await readdir(input.output_dir)).filter((name) =>
    /\.(?:partial|backup)\.(?:png|mp4)$/.test(name),
  );
  if (leftovers.length) throw new Error("temporary outputs remain: " + leftovers.join(", "));
  if ((await readFile(input.cancel_output, "utf8")) !== "old-video")
    throw new Error("cancellation damaged the previous destination");
  return {
    png_only: false,
    png_frames,
    mp4_frames,
    terminal_hashes,
    cancel_frames,
    cancelled,
    ffmpeg_crashed,
    ffmpeg_crash_closed,
    renderer_crashed,
  };
});
`;
}

async function probe_mp4(ffmpeg: string, output: string): Promise<void> {
  const ffprobe = join(dirname(ffmpeg), "ffprobe.exe");
  const { stdout } = await exec_file(ffprobe, [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames",
    "-of",
    "json",
    output,
  ]);
  const report = JSON.parse(stdout) as {
    streams?: Array<Record<string, string | number>>;
  };
  assert.ok(report.streams);
  const videos = report.streams.filter(
    (stream) => stream.codec_type === "video",
  );
  const audio = report.streams.filter(
    (stream) => stream.codec_type === "audio",
  );
  assert.equal(videos.length, 1);
  assert.equal(audio.length, 0);
  assert.deepEqual(
    {
      codec_name: videos[0].codec_name,
      width: videos[0].width,
      height: videos[0].height,
      pix_fmt: videos[0].pix_fmt,
      r_frame_rate: videos[0].r_frame_rate,
      nb_read_frames: videos[0].nb_read_frames,
    },
    {
      codec_name: "h264",
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      pix_fmt: "yuv420p",
      r_frame_rate: "60/1",
      nb_read_frames: String(EXPORT_FRAME_COUNT),
    },
  );
}

async function wait_for_file(
  path: string,
  progress_file?: string,
): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  const progress = progress_file
    ? await readFile(progress_file, "utf8").catch(() => "unavailable")
    : "unavailable";
  throw new Error(`timed out waiting for ${path}; progress: ${progress}`);
}

function process_is_alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function log_renderer_state(
  application: ElectronApplication,
  progress_file: string,
): Promise<void> {
  const states = await Promise.all(
    application.windows().map(async (page) => ({
      url: page.url(),
      state: await page
        .evaluate(() => ({
          export_api: Boolean(window.exportRendererApi),
          ready_state: document.readyState,
          root_children: document.getElementById("root")?.childElementCount,
          visualize_root: Boolean(
            document.querySelector('[data-testid="visualize-root"]'),
          ),
        }))
        .catch((error: unknown) => ({ error: String(error) })),
    })),
  );
  const progress = await readFile(progress_file, "utf8").catch(
    (error: unknown) => `unavailable: ${String(error)}`,
  );
  console.error(
    `ExportHost integration pending at ${progress}: ${JSON.stringify(states)}`,
  );
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    skip_or_throw("Windows x64 is the only supported Phase 3 target");
    return;
  }
  const ffmpeg = resolve_ffmpeg_executable({
    packaged: false,
    project_root,
  });
  const export_html = resolve("out/renderer/export.html");
  const export_preload = resolve("out/preload/export.js");
  for (const path of [export_html, export_preload]) {
    try {
      await access(path);
    } catch {
      skip_or_throw(`required integration artifact is missing: ${path}`);
      return;
    }
  }
  let png_only = false;
  for (const path of [ffmpeg, join(dirname(ffmpeg), "ffprobe.exe")]) {
    try {
      await access(path);
    } catch {
      if (require_integration) {
        throw new Error(`required integration artifact is missing: ${path}`);
      }
      png_only = true;
    }
  }
  if (png_only) {
    console.log(
      "PARTIAL export host integration: pinned FFmpeg is missing; running PNG path only",
    );
  }

  const root = await mkdtemp(
    join(tmpdir(), "gachasimulate-export-integration-"),
  );
  const harness = join(root, "harness");
  const output_dir = join(root, "outputs");
  await mkdir(harness);
  await mkdir(output_dir);
  const png_output = join(output_dir, "png-only.png");
  const mp4_output = join(output_dir, "result.mp4");
  const dual_png_output = join(output_dir, "result.png");
  const cancel_output = join(output_dir, "cancel.mp4");
  const ffmpeg_crash_output = join(output_dir, "ffmpeg-crash.mp4");
  const renderer_crash_output = join(output_dir, "renderer-crash.mp4");
  const exit_output = join(output_dir, "app-exit.mp4");
  const exit_ready = join(output_dir, "app-exit-ready.json");
  const progress_file = join(output_dir, "progress.txt");
  await writeFile(cancel_output, "old-video");
  await writeFile(
    join(harness, "package.json"),
    JSON.stringify({ private: true, main: "main.cjs" }),
  );
  await writeFile(join(harness, "main.cjs"), harness_source());

  let application: ElectronApplication | undefined;
  try {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] =>
        Boolean(entry[1]),
      ),
    );
    delete environment.ELECTRON_RUN_AS_NODE;
    environment.GACHASIMULATE_EXPORT_INTEGRATION_INPUT = JSON.stringify({
      project_package: resolve("package.json"),
      export_host_source: resolve("src/main/export_host.ts"),
      export_html,
      export_preload,
      output_dir,
      png_output,
      mp4_output,
      dual_png_output,
      cancel_output,
      ffmpeg_crash_output,
      renderer_crash_output,
      png_only,
      progress_file,
      view_model: build_cdf_view_model(
        validate_analysis(analysis_fixture),
        validate_display_config(display_fixture),
      ),
    });
    application = await electron.launch({
      args: [harness],
      cwd: project_root,
      env: environment,
    });
    application
      .process()
      .stdout?.on("data", (chunk) =>
        console.error(`Electron stdout: ${String(chunk).trimEnd()}`),
      );
    application
      .process()
      .stderr?.on("data", (chunk) =>
        console.error(`Electron stderr: ${String(chunk).trimEnd()}`),
      );
    const diagnostic = setTimeout(() => {
      void log_renderer_state(application!, progress_file).catch(
        (error: unknown) =>
          console.error(`Unable to inspect export renderer: ${String(error)}`),
      );
    }, 10_000);
    let result: HarnessResult;
    try {
      result = await application.evaluate(async () => {
        const state = globalThis as typeof globalThis & {
          exportHostIntegrationPromise: Promise<HarnessResult>;
        };
        return state.exportHostIntegrationPromise;
      });
    } catch (error) {
      const progress = await readFile(progress_file, "utf8").catch(
        () => "unavailable",
      );
      console.error(`ExportHost integration failed at ${progress}`);
      throw error;
    } finally {
      clearTimeout(diagnostic);
    }
    assert.deepEqual(result.png_frames, [EXPORT_PNG_FRAME]);
    assert.deepEqual(png_dimensions(await readFile(png_output)), {
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
    });
    if (result.png_only) {
      await application.close();
      application = undefined;
      console.log("ExportHost PNG integration passed");
      return;
    }
    assert.deepEqual(
      result.mp4_frames,
      Array.from({ length: EXPORT_FRAME_COUNT }, (_, frame) => frame),
    );
    assert.equal(new Set(result.terminal_hashes).size, 1);
    assert.deepEqual(png_dimensions(await readFile(dual_png_output)), {
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
    });
    assert.deepEqual(result.cancel_frames, [0]);
    assert.equal(result.cancelled, true);
    assert.equal(result.ffmpeg_crashed, true);
    assert.equal(result.ffmpeg_crash_closed, true);
    assert.equal(result.renderer_crashed, true);
    await probe_mp4(ffmpeg, mp4_output);

    await application.close();
    application = undefined;
    await writeFile(exit_output, "old-video");
    environment.GACHASIMULATE_EXPORT_INTEGRATION_INPUT = JSON.stringify({
      project_package: resolve("package.json"),
      export_host_source: resolve("src/main/export_host.ts"),
      export_html,
      export_preload,
      output_dir,
      exit_mode: true,
      exit_output,
      exit_ready,
      progress_file,
      view_model: build_cdf_view_model(
        validate_analysis(analysis_fixture),
        validate_display_config(display_fixture),
      ),
    });
    application = await electron.launch({
      args: [harness],
      cwd: project_root,
      env: environment,
    });
    application
      .process()
      .stdout?.on("data", (chunk) =>
        console.error(`Exit-mode Electron stdout: ${String(chunk).trimEnd()}`),
      );
    application
      .process()
      .stderr?.on("data", (chunk) =>
        console.error(`Exit-mode Electron stderr: ${String(chunk).trimEnd()}`),
      );
    const exit_state = JSON.parse(
      await wait_for_file(exit_ready, progress_file),
    ) as {
      ffmpeg_pid?: number;
      frame?: number;
      error?: string;
    };
    if (exit_state.error)
      throw new Error(`exit-mode ExportHost failed: ${exit_state.error}`);
    assert.equal(exit_state.frame, 0);
    assert.equal(process_is_alive(exit_state.ffmpeg_pid ?? 0), true);
    await application.close();
    application = undefined;
    assert.equal(await readFile(exit_output, "utf8"), "old-video");
    assert.equal(process_is_alive(exit_state.ffmpeg_pid ?? 0), false);
    assert.deepEqual(
      (await readdir(output_dir)).filter((name) =>
        /\.(?:partial|backup)\.(?:png|mp4)$/.test(name),
      ),
      [],
    );
    console.log("ExportHost integration passed");
  } finally {
    await application?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
