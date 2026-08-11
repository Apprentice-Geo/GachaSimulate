import { parse } from "yaml";

export type SimulationTarget =
  | { kind: "totalRuns"; value: number }
  | { kind: "targetTotalDraw"; value: number };

export type SimulationRequest = {
  configId: string;
  termination: string;
  target: SimulationTarget;
  seed: number;
  workers: number;
  metric: "draw" | "cost";
};

export type SimulationStatus =
  | "idle"
  | "starting"
  | "running"
  | "saving"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled";

export type SimulationStage = "loading_config" | "simulating" | "saving";

export type SimulationEvent =
  | { type: "started" }
  | { type: "stage"; stage: SimulationStage }
  | {
      type: "progress";
      completed: number;
      total: number;
      unit: "runs" | "draws";
    }
  | {
      type: "completed";
      result_path: string;
      total_runs: number;
      total_draw: number;
    }
  | { type: "error"; message: string };

export type DesktopSimulationEvent = {
  status: SimulationStatus;
  event?: SimulationEvent;
  message?: string;
};

const stages = new Set(["loading_config", "simulating", "saving"]);
const event_types = new Set([
  "started",
  "stage",
  "progress",
  "completed",
  "error",
]);

function object_value(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("event must be an object");
  return value as Record<string, unknown>;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum)
    throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function validate_simulation_request(
  request: SimulationRequest,
  logical_cpu_count = 1,
): void {
  if (!/^[A-Za-z0-9_-]+$/.test(request.configId))
    throw new Error("invalid config id");
  if (
    !request.termination ||
    request.termination.includes("\\") ||
    request.termination.includes("/")
  )
    throw new Error("termination must be a filename");
  if (!Number.isInteger(request.seed))
    throw new Error("seed must be an integer");
  integer(request.workers, "workers", 1);
  if (request.workers > logical_cpu_count)
    throw new Error(`workers must be <= ${logical_cpu_count}`);
  if (request.metric !== "draw" && request.metric !== "cost")
    throw new Error("invalid metric");
  if (
    request.target.kind !== "totalRuns" &&
    request.target.kind !== "targetTotalDraw"
  )
    throw new Error("exactly one target is required");
  integer(request.target.value, "target", 1);
}

export function validate_config_yaml(
  config_text: string,
  metric: SimulationRequest["metric"],
): void {
  const config = object_value(parse(config_text));
  const items = config.items;
  const item_id = (item: unknown): string =>
    typeof item === "string"
      ? item
      : (Object.keys(object_value(item))[0] ?? "");
  if (!Array.isArray(items)) throw new Error("config items must be an array");
  if (
    metric === "cost" &&
    !items.some((item) => item_id(item) === "cost_count")
  )
    throw new Error("metric cost requires a configured cost_count item");
}

export function validate_termination_yaml(termination_text: string): void {
  const termination = object_value(parse(termination_text));
  if (
    !termination.termination_rule ||
    typeof termination.termination_rule !== "object"
  )
    throw new Error("termination_rule is required");
}

export function parse_simulation_line(
  line: string,
  diagnostics: string[] = [],
): SimulationEvent | null {
  if (!line.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("invalid JSONL event");
  }
  const event = object_value(value);
  if (typeof event.type !== "string") throw new Error("event type is required");
  if (!event_types.has(event.type)) {
    diagnostics.push(`unknown event type: ${event.type}`);
    return null;
  }
  switch (event.type) {
    case "started":
      return { type: "started" };
    case "stage": {
      const stage = text(event.stage, "stage");
      if (!stages.has(stage)) throw new Error("invalid stage");
      return { type: "stage", stage: stage as SimulationStage };
    }
    case "progress": {
      const completed = integer(event.completed, "completed");
      const total = integer(event.total, "total", 1);
      if (
        completed > total ||
        (event.unit !== "runs" && event.unit !== "draws")
      )
        throw new Error("invalid progress event");
      return { type: "progress", completed, total, unit: event.unit };
    }
    case "completed":
      return {
        type: "completed",
        result_path: text(event.result_path, "result_path"),
        total_runs: integer(event.total_runs, "total_runs", 1),
        total_draw: integer(event.total_draw, "total_draw", 1),
      };
    case "error":
      return { type: "error", message: text(event.message, "message") };
  }
  throw new Error("unsupported event type");
}

export type ProcessOutcome = "completed" | "failed" | "cancelled";

export function resolve_process_outcome(
  exit_code: number | null,
  saw_completed: boolean,
  saw_error: boolean,
  cancelled: boolean,
): ProcessOutcome {
  if (cancelled) return "cancelled";
  if (exit_code === 0 && saw_completed && !saw_error) return "completed";
  return "failed";
}
