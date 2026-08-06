import { spawn, execFile } from "node:child_process";
import { cpus } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  parse_simulation_line,
  resolve_process_outcome,
  validate_config_yaml,
  validate_termination_yaml,
  validate_simulation_request,
  type DesktopSimulationEvent,
  type SimulationEvent,
  type SimulationRequest,
  type SimulationStatus,
} from "../shared/simulation";

const STDERR_LIMIT = 64 * 1024;

export class SimulationTask {
  private child: ChildProcess | null = null;
  private status: SimulationStatus = "idle";
  private cancelled = false;
  private saw_completed = false;
  private saw_error = false;
  private stderr = "";
  private readonly listeners = new Set<(event: DesktopSimulationEvent) => void>();

  constructor(
    private readonly installed_dir: string,
    private readonly results_dir: string,
    private readonly emit: (event: DesktopSimulationEvent) => void,
  ) {}

  get active(): boolean {
    return !["idle", "completed", "failed", "cancelled"].includes(this.status);
  }

  on_event(listener: (event: DesktopSimulationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(event: DesktopSimulationEvent): void {
    this.status = event.status;
    this.emit(event);
    for (const listener of this.listeners) listener(event);
  }

  private fail(message: string): void {
    if (this.status === "failed" || this.status === "cancelled") return;
    this.saw_error = true;
    this.notify({ status: "failed", message });
    this.child?.kill();
  }

  start(request: SimulationRequest): void {
    if (this.active) throw new Error("a simulation is already running");
    validate_simulation_request(request, cpus().length);
    const config_dir = resolve(this.installed_dir, request.configId);
    if (!relative(resolve(this.installed_dir), config_dir) ||
        relative(resolve(this.installed_dir), config_dir).startsWith("..") ||
        !existsSync(config_dir)) throw new Error("installed config not found");
    const termination = request.termination.endsWith(".yaml")
      ? request.termination
      : `${request.termination}.yaml`;
    const termination_path = resolve(config_dir, termination);
    if (isAbsolute(request.termination) || relative(config_dir, termination_path).startsWith(".."))
      throw new Error("termination must be inside config directory");
    const config_path = join(config_dir, "config.yaml");
    if (!existsSync(config_path) || !existsSync(termination_path))
      throw new Error("configuration files not found");
    validate_config_yaml(readFileSync(config_path, "utf8"), request.metric);
    validate_termination_yaml(readFileSync(termination_path, "utf8"));

    const args = [
      "run", "gachasimulate", "--config-dir", config_dir,
      "--termination", termination, request.target.kind === "totalRuns" ? "--total-runs" : "--target-total-draw",
      String(request.target.value), "--seed", String(request.seed), "--workers", String(request.workers),
      "--metric", request.metric, "--results-dir", this.results_dir, "--output-format", "jsonl",
    ];
    this.cancelled = false;
    this.saw_completed = false;
    this.saw_error = false;
    this.stderr = "";
    this.notify({ status: "starting" });
    this.child = spawn("uv", args, { cwd: process.cwd(), windowsHide: true });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    let stdout = "";
    this.child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) this.handle_line(line);
    });
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
    });
    this.child.on("error", (error) => this.fail(error.message));
    this.child.on("close", (code) => {
      if (stdout.trim()) this.handle_line(stdout);
      this.child = null;
      const outcome = resolve_process_outcome(code, this.saw_completed, this.saw_error, this.cancelled);
      if (outcome === "cancelled") this.notify({ status: "cancelled" });
      else if (outcome === "completed") this.notify({ status: "completed" });
      else this.notify({ status: "failed", message: this.stderr || "simulation process failed" });
    });
  }

  private handle_line(line: string): void {
    try {
      const diagnostics: string[] = [];
      const event = parse_simulation_line(line, diagnostics);
      for (const diagnostic of diagnostics) console.warn(`simulation stdout: ${diagnostic}`);
      if (event) this.handle_event(event);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private handle_event(event: SimulationEvent): void {
    if (event.type === "completed") this.saw_completed = true;
    if (event.type === "error") this.saw_error = true;
    const status: SimulationStatus = event.type === "stage" && event.stage === "saving"
      ? "saving"
      : event.type === "started" || event.type === "stage" || event.type === "progress"
        ? "running"
        : event.type === "error" ? "failed" : this.status;
    this.notify({ status, event, message: event.type === "error" ? event.message : undefined });
  }

  cancel(): void {
    if (!this.active || !this.child?.pid) return;
    this.cancelled = true;
    this.notify({ status: "cancelling" });
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(this.child.pid), "/T", "/F"]);
    } else {
      this.child.kill("SIGTERM");
    }
  }

  async cancel_and_wait(): Promise<void> {
    if (!this.active) return;
    await new Promise<void>((resolve) => {
      const unsubscribe = this.on_event((event) => {
        if (["completed", "failed", "cancelled"].includes(event.status)) {
          unsubscribe();
          resolve();
        }
      });
      this.cancel();
    });
  }
}
