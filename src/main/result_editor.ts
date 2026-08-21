import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DISPLAY_FIELD_KEYS,
  type DisplayFields,
  type ResultEditorState,
} from "../shared/result_editor";
import type { AnalysisV2 } from "../visualize/types/analysis";
import type { DisplayConfig } from "../visualize/types/display_config";
import { validate_analysis } from "../visualize/data/analysis";
import { validate_display_config } from "../visualize/data/validate_display_config";
import {
  resolve_native_executable,
  terminate_native_process,
} from "./simulation";

const JSON_LIMIT = 16 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

type ResultEditorDependencies = {
  spawn?: (
    command: string,
    args: string[],
    options: { cwd: string; windowsHide: boolean },
  ) => ChildProcess;
  terminate_native_process?: (child: ChildProcess) => Promise<void>;
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

function display_fields(input: DisplayConfig): DisplayFields {
  return Object.fromEntries(
    DISPLAY_FIELD_KEYS.map((key) => [key, input[key]]),
  ) as DisplayFields;
}

function sidecar_path(path: string): string {
  return `${path.slice(0, -4)}.visualize.json`;
}

export class ResultEditor {
  private path: string | null = null;
  private analysis: AnalysisV2 | null = null;
  private display: DisplayConfig | null = null;
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
    const analysis = await this.analyze(path);
    const display = this.restore_sidecar(path, analysis);
    this.path = path;
    this.analysis = analysis;
    this.display = display;
    return this.state();
  }

  save(value: unknown): ResultEditorState {
    if (!this.path || !this.analysis || !this.display)
      throw new Error("请先分析 GSR 文件");
    const fields = fields_value(value);
    const path = sidecar_path(this.path);
    const display = validate_display_config({ display_version: 1, ...fields });
    const temporary = `${path}.${(
      this.dependencies.random_uuid ?? randomUUID
    )()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(display, null, 2)}\n`, "utf8");
      renameSync(temporary, path);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    this.display = display;
    return this.state();
  }

  async cancel(): Promise<void> {
    const child = this.child;
    const close = this.child_close;
    if (!child || !close) return;
    await (
      this.dependencies.terminate_native_process ?? terminate_native_process
    )(child);
    await close;
  }

  private state(): ResultEditorState {
    if (!this.path || !this.analysis || !this.display)
      throw new Error("result editor is empty");
    return {
      path: this.path,
      filename: basename(this.path),
      fields: display_fields(this.display),
      analysis: this.analysis,
      display: this.display,
      sidecar_path: sidecar_path(this.path),
    };
  }

  private restore_sidecar(
    path: string,
    authoritative: AnalysisV2,
  ): DisplayConfig {
    const sidecar = sidecar_path(path);
    if (!existsSync(sidecar))
      return {
        display_version: 1,
        title: "模拟结果分布",
        target: "未设置",
        result_item_name: authoritative.result_item.name,
        note: "MEAN 受极端值影响，P50 表示一半结果不超过该值，P95 表示 95% 结果不超过该值。MIN、MAX 受模拟次数影响，不代表理论极限。",
        price: "",
        unit: "",
      };
    return this.read_sidecar(sidecar);
  }

  private read_sidecar(path: string): DisplayConfig {
    if (readFileSync(path).byteLength > JSON_LIMIT)
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
    try {
      return validate_display_config(value);
    } catch (error) {
      throw new Error(
        `非法 sidecar: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private analyze(path: string): Promise<AnalysisV2> {
    if (this.child) throw new Error("analyzer is already running");
    const command = resolve_native_executable(
      "gachasimulate-analyze",
      this.dependencies.native_dir,
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
            resolve_promise(validate_analysis(JSON.parse(stdout)));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  }
}
