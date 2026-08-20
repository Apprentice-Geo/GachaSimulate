import { compile_yaml, YAML_TEXT_LIMIT } from "@gachasimulate/config-compiler";
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  parse_simulation_line,
  resolve_process_outcome,
  validate_simulation_request,
  type DesktopSimulationEvent,
  type SimulationEvent,
  type SimulationStatus,
} from "../shared/simulation";
import { resolve_config_selection } from "./config_manager";

const STDERR_LIMIT = 64 * 1024;
const JSONL_LINE_LIMIT = 64 * 1024;
const TERMINATION_TIMEOUT_MS = 10_000;
const RESULT_STEM_LIMIT = 255 - Buffer.byteLength(".visualize.json");

type SimulationTaskDependencies = {
  spawn?: (
    command: string,
    args: string[],
    options: { cwd: string; windowsHide: boolean },
  ) => ChildProcess;
  terminate_native_process?: (child: ChildProcess) => Promise<void>;
  shutdown_native_processes?: () => Promise<void>;
  close_timeout_ms?: number;
  native_dir?: string;
  random_uuid?: () => string;
  local_dir?: () => string | null;
};

type NativeTask = { active: boolean; cancel(): Promise<void> };

export async function shutdown_native_processes(
  ...tasks: Array<NativeTask | undefined>
): Promise<void> {
  await Promise.all(
    tasks
      .filter((task): task is NativeTask => Boolean(task?.active))
      .map((task) => task.cancel()),
  );
}

function readable_error(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function result_basename(
  request: import("../shared/simulation").SimulationRequest,
): string {
  const termination = request.termination
    .replace(/\.yaml$/i, "")
    .replace(/[^A-Za-z0-9_-]/g, "_");
  const readable = `${request.configSource}-${request.configId}-${termination}-${request.resultItem}`;
  const hash = createHash("sha256")
    .update(
      [
        request.configSource,
        request.configId,
        request.termination,
        request.resultItem,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 12);
  const suffix = `-${hash}-runs${request.target.value}-seed${request.seed}-threads${request.threads}`;
  return `${readable.slice(0, RESULT_STEM_LIMIT - suffix.length)}${suffix}.gsr`;
}

export async function terminate_native_process(
  child: ChildProcess,
): Promise<void> {
  if (process.platform !== "win32") {
    try {
      if (!child.kill("SIGTERM")) throw new Error("process was not running");
      return;
    } catch (error) {
      throw new Error(
        `failed to terminate native process: ${readable_error(error).message}`,
        { cause: error },
      );
    }
  }
  if (!child.pid)
    throw new Error("failed to terminate native process: process has no PID");
  await new Promise<void>((resolve, reject) => {
    execFile(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { timeout: TERMINATION_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        const detail = stderr.trim();
        if (error) {
          reject(
            new Error(
              `failed to terminate native process: ${detail || error.message}`,
            ),
          );
        } else {
          resolve();
        }
      },
    );
  });
}

export class SimulationTask {
  private child: ChildProcess | null = null;
  private child_close: Promise<Error | null> | null = null;
  private cancel_promise: Promise<void> | null = null;
  private status: SimulationStatus = "idle";
  private cancelled = false;
  private saw_completed = false;
  private saw_error = false;
  private protocol_error: string | null = null;
  private core_error: string | null = null;
  private process_error: string | null = null;
  private protocol_stop_started = false;
  private stderr = "";
  private temporary_dir: string | null = null;
  private temporary_output = "";
  private final_output = "";
  private completed_event: Extract<
    SimulationEvent,
    { type: "completed" }
  > | null = null;

  constructor(
    private readonly installed_dir: string,
    private readonly results_dir: string,
    private readonly emit: (event: DesktopSimulationEvent) => void,
    private readonly dependencies: SimulationTaskDependencies = {},
  ) {}

  get active(): boolean {
    return this.child !== null;
  }

  private notify(event: DesktopSimulationEvent): void {
    this.status = event.status;
    this.emit(event);
  }

  start(value: unknown): void {
    if (this.active) throw new Error("a simulation is already running");
    validate_simulation_request(value, cpus().length);
    const request = value;
    const config_dir = resolve_config_selection(
      this.installed_dir,
      this.dependencies.local_dir?.() ?? null,
      request.configSource,
      request.configId,
      request.termination,
    );
    const termination = request.termination;
    const termination_path = resolve(config_dir, termination);
    if (
      isAbsolute(request.termination) ||
      basename(termination) !== termination ||
      relative(config_dir, termination_path).startsWith("..")
    )
      throw new Error("termination must be inside config directory");
    const config_path = join(config_dir, "config.yaml");
    const manifest_path = join(config_dir, "manifest.yaml");
    if (
      !existsSync(config_path) ||
      !existsSync(termination_path) ||
      !existsSync(manifest_path)
    )
      throw new Error("configuration files not found");
    for (const path of [config_path, termination_path, manifest_path])
      if (statSync(path).size > YAML_TEXT_LIMIT)
        throw new Error(`${basename(path)} exceeds 1 MiB`);
    const program = compile_yaml(
      readFileSync(config_path, "utf8"),
      readFileSync(termination_path, "utf8"),
      readFileSync(manifest_path, "utf8"),
      request.resultItem,
    );

    mkdirSync(this.results_dir, { recursive: true });
    this.final_output = join(this.results_dir, result_basename(request));
    this.temporary_output = join(
      this.results_dir,
      `.${(this.dependencies.random_uuid ?? randomUUID)()}.tmp.gsr`,
    );
    this.temporary_dir = mkdtempSync(join(tmpdir(), "gachasimulate-electron-"));
    const ir = join(this.temporary_dir, "program.json");
    const native_dir = resolve(
      this.dependencies.native_dir ??
        (process.env.ELECTRON_RENDERER_URL || !process.resourcesPath
          ? join(process.cwd(), "build", "native", "bin")
          : join(process.resourcesPath, "native", "bin")),
    );
    const command = join(
      native_dir,
      `gachasimulate-core${process.platform === "win32" ? ".exe" : ""}`,
    );
    const args = [
      "--ir",
      ir,
      "--total-runs",
      String(request.target.value),
      "--seed",
      String(request.seed),
      "--threads",
      String(request.threads),
      "--output",
      this.temporary_output,
    ];
    this.cancelled = false;
    this.saw_completed = false;
    this.saw_error = false;
    this.protocol_error = null;
    this.core_error = null;
    this.process_error = null;
    this.protocol_stop_started = false;
    this.completed_event = null;
    this.stderr = "";
    this.notify({ status: "starting" });
    let child: ChildProcess;
    try {
      writeFileSync(ir, JSON.stringify(program.ir));
      if (!existsSync(command))
        throw new Error(`native core not found: ${command}`);
      child = (this.dependencies.spawn ?? spawn)(command, args, {
        cwd: native_dir,
        windowsHide: true,
      });
    } catch (error) {
      this.cleanup_temporary_ir();
      this.cleanup_output();
      throw error;
    }
    this.child = child;
    let resolve_close!: (error: Error | null) => void;
    this.child_close = new Promise<Error | null>((resolve) => {
      resolve_close = resolve;
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    let stdout = "";
    // ? 是可选链运算符 若前面是 null 或 undefined 则返回 undefined 否则返回前面的值
    child.stdout?.on("data", (chunk: string) => {
      if (this.protocol_error) return;
      stdout += chunk;
      // 以换行符分隔 兼容 windows 的 \r\n 和 linux 的 \n
      const lines = stdout.split(/\r?\n/);
      // ?? 是空值合并运算符 若前面是 null 或 undefined 则返回后面的值 否则返回前面的值
      // 将最后一个保存到 stdout 中 以便下一次接收数据时继续处理
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        this.handle_line(line);
        if (this.protocol_error) return;
      }
      if (Buffer.byteLength(stdout, "utf8") > JSONL_LINE_LIMIT)
        this.fail_protocol("core JSONL line exceeds 64 KiB");
    });
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.on("error", (error) => {
      if (this.child === child && !this.process_error)
        this.process_error = error.message;
    });
    child.on("close", (code) => {
      if (this.child !== child) return;
      if (stdout.trim() && !this.protocol_error) this.handle_line(stdout);
      const outcome = resolve_process_outcome(
        code,
        this.saw_completed,
        this.saw_error,
        this.cancelled,
      );
      let cleanup_error: Error | null = null;
      try {
        this.cleanup_temporary_ir();
      } catch (error) {
        cleanup_error = readable_error(error);
      }
      if (this.protocol_error || outcome !== "completed") {
        try {
          this.cleanup_output();
        } catch (error) {
          cleanup_error ??= readable_error(error);
        }
      } else {
        try {
          renameSync(this.temporary_output, this.final_output);
          this.temporary_output = "";
          rmSync(`${this.final_output.slice(0, -4)}.visualize.json`, {
            force: true,
          });
        } catch (error) {
          cleanup_error ??= readable_error(error);
          try {
            this.cleanup_output();
          } catch (cleanup) {
            cleanup_error ??= readable_error(cleanup);
          }
        }
      }
      this.child = null;
      this.child_close = null;
      resolve_close(cleanup_error);
      if (cleanup_error) {
        this.notify({ status: "failed", message: cleanup_error.message });
      } else if (this.protocol_error) {
        this.notify({ status: "failed", message: this.protocol_error });
      } else if (outcome === "cancelled") this.notify({ status: "cancelled" });
      else if (outcome === "completed")
        this.notify({
          status: "completed",
          event: { ...this.completed_event!, result_path: this.final_output },
        });
      else
        this.notify({
          status: "failed",
          message:
            this.core_error ||
            this.stderr.trim() ||
            this.process_error ||
            "simulation process failed",
        });
    });
  }

  private cleanup_temporary_ir(): void {
    if (!this.temporary_dir) return;
    rmSync(this.temporary_dir, { recursive: true, force: true });
    this.temporary_dir = null;
  }

  private cleanup_output(): void {
    if (this.temporary_output && existsSync(this.temporary_output))
      unlinkSync(this.temporary_output);
    this.temporary_output = "";
  }

  private handle_line(line: string): void {
    try {
      if (Buffer.byteLength(line, "utf8") > JSONL_LINE_LIMIT)
        throw new Error("core JSONL line exceeds 64 KiB");
      const diagnostics: string[] = [];
      const event = parse_simulation_line(line, diagnostics);
      for (const diagnostic of diagnostics)
        console.warn(`simulation stdout: ${diagnostic}`);
      if (event) this.handle_event(event);
    } catch (error) {
      this.fail_protocol(readable_error(error).message);
    }
  }

  private fail_protocol(message: string): void {
    if (!this.protocol_error) this.protocol_error = message;
    const child = this.child;
    if (child && !this.protocol_stop_started) {
      this.protocol_stop_started = true;
      void this.stop_after_protocol_error(child, this.status);
    }
  }

  private async stop_after_protocol_error(
    child: ChildProcess,
    previous_status: SimulationStatus,
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    this.notify({ status: "cancelling" });
    try {
      if (this.dependencies.shutdown_native_processes)
        await this.dependencies.shutdown_native_processes();
      else {
        await (
          this.dependencies.terminate_native_process ?? terminate_native_process
        )(child);
        await this.wait_for_close(child);
      }
    } catch (error) {
      if (this.child !== child) return;
      const failure = readable_error(error);
      this.notify({ status: previous_status, message: failure.message });
    }
  }

  private handle_event(event: SimulationEvent): void {
    if (event.type === "completed") {
      if (resolve(event.result_path) !== resolve(this.temporary_output))
        throw new Error("core returned an unexpected result path");
      this.saw_completed = true;
      this.completed_event = event;
      return;
    }
    if (event.type === "error") {
      this.saw_error = true;
      if (!this.core_error) this.core_error = event.message;
    }
    const status: SimulationStatus =
      this.status === "cancelling"
        ? "cancelling"
        : event.type === "stage" && event.stage === "saving"
          ? "saving"
          : event.type === "started" ||
              event.type === "stage" ||
              event.type === "progress"
            ? "running"
            : this.status;
    this.notify({
      status,
      event,
      message: event.type === "error" ? event.message : undefined,
    });
  }

  private async wait_for_close(child: ChildProcess): Promise<void> {
    const close = this.child === child ? this.child_close : null;
    if (!close) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const cleanup_error = await Promise.race([
        close,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("simulation process close timed out")),
            this.dependencies.close_timeout_ms ?? TERMINATION_TIMEOUT_MS,
          );
        }),
      ]);
      if (cleanup_error) throw cleanup_error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async cancel(): Promise<void> {
    if (this.cancel_promise) return this.cancel_promise;
    const child = this.child;
    if (!child) return;
    const previous_status =
      this.status === "cancelling" ? "running" : this.status;
    this.cancelled = true;
    this.notify({ status: "cancelling" });
    const cancellation = (async () => {
      try {
        await (
          this.dependencies.terminate_native_process ?? terminate_native_process
        )(child);
      } catch (error) {
        if (this.child !== child) return;
        this.cancelled = false;
        const failure = readable_error(error);
        this.notify({ status: previous_status, message: failure.message });
        throw failure;
      }
      try {
        await this.wait_for_close(child);
      } catch (error) {
        const failure = readable_error(error);
        if (this.child === child) {
          this.cancelled = false;
          this.notify({ status: previous_status, message: failure.message });
        }
        throw failure;
      }
    })();
    this.cancel_promise = cancellation;
    try {
      await cancellation;
    } finally {
      if (this.cancel_promise === cancellation) this.cancel_promise = null;
    }
  }
}
