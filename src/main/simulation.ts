import { compile_yaml } from "@gachasimulate/config-compiler";
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

const STDERR_LIMIT = 64 * 1024;
const TERMINATION_TIMEOUT_MS = 10_000;

type SimulationTaskDependencies = {
  spawn?: (
    command: string,
    args: string[],
    options: { cwd: string; windowsHide: boolean },
  ) => ChildProcess;
  terminate_process_tree?: (child: ChildProcess) => Promise<void>;
  close_timeout_ms?: number;
  native_dir?: string;
  now?: () => Date;
  random_uuid?: () => string;
};

function readable_error(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export async function terminate_process_tree(
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
  private child_close: Promise<void> | null = null;
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
  private expected_output = "";

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
    const config_dir = resolve(this.installed_dir, request.configId);
    if (
      !relative(resolve(this.installed_dir), config_dir) ||
      relative(resolve(this.installed_dir), config_dir).startsWith("..") ||
      !existsSync(config_dir)
    )
      throw new Error("installed config not found");
    const termination = request.termination.endsWith(".yaml")
      ? request.termination
      : `${request.termination}.yaml`;
    const termination_path = resolve(config_dir, termination);
    if (
      isAbsolute(request.termination) ||
      basename(termination) !== termination ||
      relative(config_dir, termination_path).startsWith("..")
    )
      throw new Error("termination must be inside config directory");
    const config_path = join(config_dir, "config.yaml");
    const manifest_path = join(config_dir, "manifest.yaml");
    if (!existsSync(config_path) || !existsSync(termination_path))
      throw new Error("configuration files not found");
    const program = compile_yaml(
      readFileSync(config_path, "utf8"),
      readFileSync(termination_path, "utf8"),
      existsSync(manifest_path)
        ? readFileSync(manifest_path, "utf8")
        : undefined,
    );

    mkdirSync(this.results_dir, { recursive: true });
    const timestamp = (this.dependencies.now ?? (() => new Date()))()
      .toISOString()
      .replace(/[-:.]/g, "");
    const id = (this.dependencies.random_uuid ?? randomUUID)();
    const termination_stem = termination
      .replace(/\.yaml$/i, "")
      .replace(/[^A-Za-z0-9_-]/g, "_");
    this.expected_output = join(
      this.results_dir,
      `${request.configId}-${termination_stem}-${request.target.kind}-${request.target.value}-seed${request.seed}-threads${request.threads}-${timestamp}-${id}.gsr`,
    );
    this.temporary_dir = mkdtempSync(join(tmpdir(), "gachasimulate-electron-"));
    const ir = join(this.temporary_dir, "program.json");
    writeFileSync(ir, JSON.stringify(program.ir));
    const native_dir = resolve(
      this.dependencies.native_dir ??
        join(process.cwd(), "build", "native", "bin"),
    );
    const command = join(
      native_dir,
      `gachasimulate-core${process.platform === "win32" ? ".exe" : ""}`,
    );
    if (!existsSync(command)) {
      this.cleanup_temporary_ir();
      throw new Error(`native core not found: ${command}`);
    }
    const args = [
      "--ir",
      ir,
      request.target.kind === "totalRuns"
        ? "--total-runs"
        : "--target-total-draw",
      String(request.target.value),
      "--seed",
      String(request.seed),
      "--threads",
      String(request.threads),
      "--output",
      this.expected_output,
    ];
    this.cancelled = false;
    this.saw_completed = false;
    this.saw_error = false;
    this.protocol_error = null;
    this.core_error = null;
    this.process_error = null;
    this.protocol_stop_started = false;
    this.stderr = "";
    this.notify({ status: "starting" });
    let child: ChildProcess;
    try {
      child = (this.dependencies.spawn ?? spawn)(command, args, {
        cwd: native_dir,
        windowsHide: true,
      });
    } catch (error) {
      this.cleanup_temporary_ir();
      throw error;
    }
    this.child = child;
    let resolve_close!: () => void;
    this.child_close = new Promise<void>((resolve) => {
      resolve_close = resolve;
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    let stdout = "";
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) this.handle_line(line);
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
      if (stdout.trim()) this.handle_line(stdout);
      this.child = null;
      this.child_close = null;
      this.cleanup_temporary_ir();
      resolve_close();
      const outcome = resolve_process_outcome(
        code,
        this.saw_completed,
        this.saw_error,
        this.cancelled,
      );
      if (this.protocol_error) {
        this.notify({ status: "failed", message: this.protocol_error });
      } else if (outcome === "cancelled") this.notify({ status: "cancelled" });
      else if (outcome === "completed") this.notify({ status: "completed" });
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

  private handle_line(line: string): void {
    try {
      const diagnostics: string[] = [];
      const event = parse_simulation_line(line, diagnostics);
      for (const diagnostic of diagnostics)
        console.warn(`simulation stdout: ${diagnostic}`);
      if (event) this.handle_event(event);
    } catch (error) {
      if (!this.protocol_error)
        this.protocol_error = readable_error(error).message;
      const child = this.child;
      if (child && !this.protocol_stop_started) {
        this.protocol_stop_started = true;
        void this.stop_after_protocol_error(child, this.status);
      }
    }
  }

  private async stop_after_protocol_error(
    child: ChildProcess,
    previous_status: SimulationStatus,
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    this.notify({ status: "cancelling" });
    try {
      await (
        this.dependencies.terminate_process_tree ?? terminate_process_tree
      )(child);
      await this.wait_for_close(child);
    } catch (error) {
      if (this.child !== child) return;
      const failure = readable_error(error);
      this.notify({ status: previous_status, message: failure.message });
    }
  }

  private handle_event(event: SimulationEvent): void {
    if (event.type === "completed") {
      if (resolve(event.result_path) !== resolve(this.expected_output))
        throw new Error("core returned an unexpected result path");
      this.saw_completed = true;
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
      await Promise.race([
        close,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("simulation process close timed out")),
            this.dependencies.close_timeout_ms ?? TERMINATION_TIMEOUT_MS,
          );
        }),
      ]);
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
          this.dependencies.terminate_process_tree ?? terminate_process_tree
        )(child);
        await this.wait_for_close(child);
      } catch (error) {
        if (this.child !== child) return;
        this.cancelled = false;
        const failure = readable_error(error);
        this.notify({ status: previous_status, message: failure.message });
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
