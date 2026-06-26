import { chromium, type Browser, type BrowserContext } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ANIMATION_TOTAL_MS, EXPORT_BUFFER_MS } from "../animation/timeline";
import {
  probe_video_duration_seconds,
  transcode_webm_to_mp4,
  trim_video_to_webm,
} from "./ffmpeg";
import {
  DEFAULT_OUTPUT_DIR,
  ensure_output_dir,
  PROJECT_ROOT,
  remove_existing_final_outputs,
  resolve_project_relative_path,
} from "./paths";

const PREVIEW_PORT = 4173;
const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`;
const VIEWPORT = { width: 3840, height: 2160 } as const;
const TRIM_PREROLL_SECONDS = 0.3;

interface CliArgs {
  input: string | null;
}

function parse_args(argv: string[]): CliArgs {
  const input_index = argv.indexOf("--input");
  return {
    input:
      input_index >= 0 && argv[input_index + 1] ? argv[input_index + 1] : null,
  };
}

function pnpm_command(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function platform_command(command: string, args: string[]) {
  if (process.platform !== "win32") {
    return { command, args };
  }

  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].join(" ")],
  };
}

function run_command(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = platform_command(command, args);
    const child = spawn(platform.command, platform.args, {
      cwd: PROJECT_ROOT,
      shell: false,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} ${args.join(" ")} exited with code ${code}`),
      );
    });
  });
}

function start_preview_server(): ChildProcess {
  const platform = platform_command(pnpm_command(), [
    "run",
    "preview",
    "--",
    "--host",
    "127.0.0.1",
    "--port",
    String(PREVIEW_PORT),
    "--strictPort",
  ]);

  return spawn(platform.command, platform.args, {
    cwd: PROJECT_ROOT,
    shell: false,
    stdio: "inherit",
  });
}

function assert_preview_port_available(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`预览端口 ${PREVIEW_PORT} 已被占用。`));
        return;
      }

      reject(error);
    });
    server.once("listening", () => {
      server.close(() => resolve());
    });
    server.listen(PREVIEW_PORT, "127.0.0.1");
  });
}

function create_preview_exit_error(
  code: number | null,
  signal: NodeJS.Signals | null,
) {
  const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
  return new Error(`vite preview 在就绪前退出（${status}）。`);
}

async function wait_for_preview_server(server: ChildProcess) {
  const deadline = Date.now() + 20_000;

  return new Promise<void>((resolve, reject) => {
    let timeout_id: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      settled = true;
      if (timeout_id) {
        clearTimeout(timeout_id);
      }
      server.off("error", on_error);
      server.off("exit", on_exit);
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      cleanup();
      callback();
    };
    const on_error = (error: Error) => {
      settle(() => reject(error));
    };
    const on_exit = (code: number | null, signal: NodeJS.Signals | null) => {
      settle(() => reject(create_preview_exit_error(code, signal)));
    };
    const poll = async () => {
      if (settled) {
        return;
      }

      if (Date.now() >= deadline) {
        settle(() => reject(new Error("vite preview 启动超时。")));
        return;
      }

      try {
        const response = await fetch(PREVIEW_URL);
        if (
          response.ok &&
          server.exitCode === null &&
          server.signalCode === null
        ) {
          settle(resolve);
          return;
        }
      } catch {
        // Retry until the spawned preview server responds or exits.
      }

      timeout_id = setTimeout(poll, 250);
    };

    server.once("error", on_error);
    server.once("exit", on_exit);
    poll();
  });
}

async function stop_preview_server(server: ChildProcess) {
  if (server.killed || server.exitCode !== null) {
    return;
  }

  if (process.platform === "win32" && server.pid) {
    await new Promise<void>((resolve, reject) => {
      const taskkill = spawn(
        "taskkill",
        ["/pid", String(server.pid), "/t", "/f"],
        {
          stdio: "ignore",
        },
      );
      taskkill.on("error", reject);
      taskkill.on("close", () => resolve());
    });
  } else {
    server.kill();
  }

  await new Promise<void>((resolve) => {
    const timeout_id = setTimeout(resolve, 1_000);
    server.once("exit", () => {
      clearTimeout(timeout_id);
      resolve();
    });
  });
}

async function export_cdf(input_path: string) {
  const resolved_input_path = resolve_project_relative_path(input_path);
  const normalized_input_path = path
    .relative(PROJECT_ROOT, resolved_input_path)
    .replaceAll(path.sep, "/");
  const output_dir = DEFAULT_OUTPUT_DIR;
  const png_path = path.join(output_dir, "cdf-result.png");
  const webm_path = path.join(output_dir, "cdf-animation.webm");
  const mp4_path = path.join(output_dir, "cdf-animation.mp4");
  const temp_dir = await mkdtemp(path.join(os.tmpdir(), "cdf-export-"));

  await ensure_output_dir(output_dir);
  await remove_existing_final_outputs(output_dir);
  await run_command(pnpm_command(), ["run", "build"]);
  await assert_preview_port_available();

  const server = start_preview_server();
  let raw_video_path: string | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    await wait_for_preview_server(server);

    browser = await chromium.launch({
      headless: true,
      args: ["--disable-frame-rate-limit", "--disable-gpu-vsync"],
    });
    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      recordVideo: {
        dir: temp_dir,
        size: VIEWPORT,
      },
    });

    const page = await context.newPage();
    const url = `${PREVIEW_URL}/?input=${encodeURIComponent(normalized_input_path)}&autoplay=0`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page
      .locator('[data-testid="visualize-root"][data-load-state="ready"]')
      .waitFor({
        timeout: 15_000,
      });
    await page.evaluate(() => document.fonts.ready);

    const replay_button = page.locator('[data-testid="replay-animation"]');
    await replay_button.waitFor({ state: "visible" });
    await replay_button.click();
    const replay_started_at = Date.now();
    await page.waitForTimeout(ANIMATION_TOTAL_MS + EXPORT_BUFFER_MS);
    await page.screenshot({ path: png_path, fullPage: false });
    const recording_finished_at = Date.now();

    const video = page.video();
    await context.close();
    context = null;
    await browser.close();
    browser = null;

    if (!video) {
      throw new Error("Playwright 未生成录屏文件。");
    }
    raw_video_path = await video.path();

    const raw_duration_seconds =
      await probe_video_duration_seconds(raw_video_path);
    const replay_recording_seconds =
      (recording_finished_at - replay_started_at) / 1000;
    const trim_start_seconds = Math.max(
      0,
      raw_duration_seconds - replay_recording_seconds - TRIM_PREROLL_SECONDS,
    );
    await trim_video_to_webm(
      raw_video_path,
      webm_path,
      trim_start_seconds,
      (ANIMATION_TOTAL_MS + 200) / 1000,
    );
    await transcode_webm_to_mp4(webm_path, mp4_path);
  } finally {
    if (context) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
    await stop_preview_server(server);
    if (raw_video_path) {
      await rm(raw_video_path, { force: true });
    }
    await rm(temp_dir, { force: true, recursive: true });
  }
}

async function main() {
  const args = parse_args(process.argv.slice(2));
  if (!args.input) {
    throw new Error(
      "缺少 --input 参数。用法：pnpm run export:cdf -- --input <json文件路径>",
    );
  }

  await export_cdf(args.input);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
