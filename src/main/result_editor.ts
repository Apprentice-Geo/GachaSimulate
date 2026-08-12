import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DISPLAY_FIELD_KEYS,
  type DisplayFields,
  type ResultEditorState,
} from "../shared/result_editor";
import type { VisualizeInput } from "../visualize/types/visualize_input";
import { analysis_to_visualize } from "../visualize/data/analysis";
import { validate_input } from "../visualize/data/validate_input";
import { terminate_process_tree } from "./simulation";

const JSON_LIMIT = 16 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

type ResultEditorDependencies = {
  spawn?: (
    command: string,
    args: string[],
    options: { cwd: string; windowsHide: boolean },
  ) => ChildProcess;
  terminate_process_tree?: (child: ChildProcess) => Promise<void>;
  native_dir?: string;
  random_uuid?: () => string;
};

function fields_value(value: unknown): DisplayFields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("display fields must be an object");
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== DISPLAY_FIELD_KEYS.length ||
    DISPLAY_FIELD_KEYS.some((key) => typeof fields[key] !== "string") ||
    Object.keys(fields).some(
      (key) => !DISPLAY_FIELD_KEYS.includes(key as keyof DisplayFields),
    )
  )
    throw new Error("invalid display fields");
  return fields as DisplayFields;
}

function display_fields(input: VisualizeInput): DisplayFields {
  return Object.fromEntries(
    DISPLAY_FIELD_KEYS.map((key) => [key, input[key]]),
  ) as DisplayFields;
}

function sidecar_path(path: string): string {
  return `${path.slice(0, -4)}.visualize.json`;
}

export class ResultEditor {
  private path: string | null = null;
  private input: VisualizeInput | null = null;
  private child: ChildProcess | null = null;
  private child_close: Promise<void> | null = null;

  constructor(private readonly dependencies: ResultEditorDependencies = {}) {}

  get active(): boolean {
    return this.child !== null;
  }

  async open(path_value: string): Promise<ResultEditorState> {
    const path = resolve(path_value);
    if (!isAbsolute(path_value) || !path.toLowerCase().endsWith(".gsr"))
      throw new Error("请选择 .gsr 结果文件");
    const input = await this.analyze(path);
    const restored = this.restore_sidecar(path, input);
    this.path = path;
    this.input = restored;
    return this.state();
  }

  save(value: unknown): ResultEditorState {
    if (!this.path || !this.input) throw new Error("请先分析 GSR 文件");
    const fields = fields_value(value);
    const path = sidecar_path(this.path);
    if (existsSync(path)) this.read_sidecar(path);
    const merged = { ...this.input, ...fields };
    const validation = validate_input(merged);
    if (!validation.valid || !validation.data)
      throw new Error(validation.errors.join("; "));
    const temporary = `${path}.${(
      this.dependencies.random_uuid ?? randomUUID
    )()}.tmp`;
    try {
      writeFileSync(
        temporary,
        `${JSON.stringify(validation.data, null, 2)}\n`,
        "utf8",
      );
      renameSync(temporary, path);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    this.input = validation.data;
    return this.state();
  }

  async cancel(): Promise<void> {
    const child = this.child;
    const close = this.child_close;
    if (!child || !close) return;
    await (this.dependencies.terminate_process_tree ?? terminate_process_tree)(
      child,
    );
    await close;
  }

  private state(): ResultEditorState {
    if (!this.path || !this.input) throw new Error("result editor is empty");
    return {
      path: this.path,
      filename: basename(this.path),
      fields: display_fields(this.input),
      input: this.input,
      sidecar_path: sidecar_path(this.path),
    };
  }

  private restore_sidecar(
    path: string,
    authoritative: VisualizeInput,
  ): VisualizeInput {
    const sidecar = sidecar_path(path);
    if (!existsSync(sidecar)) return authoritative;
    const saved = this.read_sidecar(sidecar);
    const merged = { ...authoritative, ...display_fields(saved) };
    const validation = validate_input(merged);
    if (!validation.valid || !validation.data)
      throw new Error(`非法 sidecar: ${validation.errors.join("; ")}`);
    return validation.data;
  }

  private read_sidecar(path: string): VisualizeInput {
    if (statSync(path).size > JSON_LIMIT)
      throw new Error("非法 sidecar: 文件超过 16 MiB");
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(
        `非法 sidecar: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const validation = validate_input(value);
    if (!validation.valid || !validation.data)
      throw new Error(`非法 sidecar: ${validation.errors.join("; ")}`);
    return validation.data;
  }

  private analyze(path: string): Promise<VisualizeInput> {
    if (this.child) throw new Error("analyzer is already running");
    const native_dir = resolve(
      this.dependencies.native_dir ??
        join(process.cwd(), "build", "native", "bin"),
    );
    const command = join(
      native_dir,
      `gachasimulate-analyze${process.platform === "win32" ? ".exe" : ""}`,
    );
    if (!existsSync(command))
      throw new Error(`native analyzer not found: ${command}`);
    return new Promise((resolve_promise, reject) => {
      const child = (this.dependencies.spawn ?? spawn)(
        command,
        ["--input", path],
        { cwd: dirname(command), windowsHide: true },
      );
      this.child = child;
      let stdout = "";
      let stdout_size = 0;
      let stderr = "";
      let process_error: Error | null = null;
      let resolve_close!: () => void;
      this.child_close = new Promise<void>((done) => {
        resolve_close = done;
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout_size += Buffer.byteLength(chunk);
        if (stdout_size <= JSON_LIMIT) stdout += chunk;
        else void this.cancel().catch(() => undefined);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_LIMIT);
      });
      child.once("error", (error) => {
        process_error = error;
      });
      child.once("close", (code) => {
        if (this.child === child) {
          this.child = null;
          this.child_close = null;
        }
        resolve_close();
        if (stdout_size > JSON_LIMIT)
          reject(new Error("analyzer JSON exceeds 16 MiB"));
        else if (code !== 0)
          reject(
            new Error(
              stderr.trim() || process_error?.message || "analyzer failed",
            ),
          );
        else {
          try {
            resolve_promise(
              analysis_to_visualize(JSON.parse(stdout), statSync(path).mtimeMs),
            );
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  }
}
