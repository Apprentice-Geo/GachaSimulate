export type SimulationTarget = { kind: "totalRuns"; value: number };
export const MAX_TOTAL_RUNS = 1_000_000_007;

export type SimulationRequest = {
  configSource: import("./installed_config").ConfigSource;
  configId: string;
  termination: string;
  resultItem: string;
  target: SimulationTarget;
  seed: number;
  threads: number;
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
      unit: "runs";
    }
  | {
      type: "completed";
      result_path: string;
      total_runs: number;
      total_result: number;
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

function exact_keys(
  value: Record<string, unknown>,
  expected: string[],
  name: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  )
    throw new Error(`${name} contains unsupported fields`);
}

export function validate_simulation_request(
  value: unknown,
  logical_cpu_count = 1,
): asserts value is SimulationRequest {
  const request = object_value(value);
  exact_keys(
    request,
    [
      "configSource",
      "configId",
      "termination",
      "resultItem",
      "target",
      "seed",
      "threads",
    ],
    "simulation request",
  );
  if (request.configSource !== "installed" && request.configSource !== "local")
    throw new Error("invalid config source");
  if (
    typeof request.configId !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(request.configId)
  )
    throw new Error("invalid config id");
  if (
    typeof request.termination !== "string" ||
    !request.termination ||
    request.termination.includes("\\") ||
    request.termination.includes("/")
  )
    throw new Error("termination must be a filename");
  if (
    typeof request.resultItem !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.resultItem)
  )
    throw new Error("resultItem must be an item id");
  if (!Number.isSafeInteger(request.seed))
    throw new Error("seed must be a safe integer");
  const threads = integer(request.threads, "threads", 1);
  if (threads > logical_cpu_count)
    throw new Error(`threads must be <= ${logical_cpu_count}`);
  const target = object_value(request.target);
  exact_keys(target, ["kind", "value"], "target");
  if (target.kind !== "totalRuns") throw new Error("target must be totalRuns");
  const target_value = integer(target.value, "target", 1);
  if (target_value > MAX_TOTAL_RUNS)
    throw new Error(`totalRuns must be <= ${MAX_TOTAL_RUNS}`);
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
      if (completed > total || event.unit !== "runs")
        throw new Error("invalid progress event");
      return { type: "progress", completed, total, unit: event.unit };
    }
    case "completed":
      return {
        type: "completed",
        result_path: text(event.result_path, "result_path"),
        total_runs: integer(event.total_runs, "total_runs", 1),
        total_result: integer(event.total_result, "total_result"),
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
