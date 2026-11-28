import { validate_analysis } from "../visualize/data/analysis";
import { validate_display_config } from "../visualize/data/validate_display_config";
import type { Analysis } from "../visualize/types/analysis";
import type { DisplayConfig } from "../visualize/types/display_config";
import type { AppLink } from "./app_info";
import type {
  ConfigItem,
  ConfigSource,
  InstalledConfig,
} from "./installed_config";
import { DISPLAY_FIELD_KEYS, type DisplayFields } from "./result_editor";
import { MAX_TOTAL_RUNS } from "./simulation";

export type {
  Analysis,
  AppLink,
  ConfigItem,
  ConfigSource,
  DisplayConfig,
  DisplayFields,
  InstalledConfig,
};
export type { InstalledTermination } from "./installed_config";

export const MAX_RUNS = MAX_TOTAL_RUNS;
export const MAX_DESKTOP_THREADS = 256;
export const DISPLAY_CONFIG_JSON_BYTE_LIMIT = 16 * 1024 * 1024;
export const SIMULATION_EVENT_NAME = "simulation://event";

export type DesktopErrorCode =
  | "invalidRequest"
  | "notFound"
  | "conflict"
  | "cancelled"
  | "io"
  | "compile"
  | "repository"
  | "simulation"
  | "analysis"
  | "sidecar"
  | "cleanupBlocked"
  | "internal"
  | "notImplemented";
export type DesktopError = { code: DesktopErrorCode; message: string };

export type RepositoryConfigStatus =
  | "available"
  | "installed"
  | "updateAvailable"
  | "removed";
export type RepositoryConfig = {
  id: string;
  name: string;
  description: string;
  status: RepositoryConfigStatus;
};
export type ConfigRepositoryState = {
  official: RepositoryConfig[];
  localDirectory: string | null;
  localConfigs: InstalledConfig[];
  sourceError: string | null;
  localError: string | null;
};

export type TerminationSource = { file: string; content: string };
export type ConfigSnapshot = {
  manifestYaml: string;
  configYaml: string;
  terminations: TerminationSource[];
};
export type ResolvedConfigSnapshot = {
  source: ConfigSource;
  configId: string;
  snapshot: ConfigSnapshot;
};

export type SimulationCommandRequest = {
  configSource: ConfigSource;
  configId: string;
  termination: string;
  resultItem: string;
  totalRuns: number;
  seed: number;
  threads: number;
};

const SIMULATION_STATUSES = [
  "idle",
  "starting",
  "running",
  "saving",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
] as const;
const SIMULATION_STAGES = ["loadingConfig", "simulating", "saving"] as const;

export type SimulationStatus = (typeof SIMULATION_STATUSES)[number];
export type SimulationStage = (typeof SIMULATION_STAGES)[number];
/** Canonical unsigned 64-bit decimal string. Use BigInt for arithmetic. */
export type U64Decimal = string;
export type SimulationTaskSnapshot = {
  taskId: number | null;
  seq: number;
  status: SimulationStatus;
  stage: SimulationStage | null;
  completedRuns: number;
  totalRuns: number;
  totalResult: U64Decimal | null;
  resultFilename: string | null;
  message: string | null;
  cancelRetryable: boolean;
};
export type SimulationTaskEvent = {
  taskId: number;
  seq: number;
  snapshot: SimulationTaskSnapshot;
};
export type CancelSimulationRequest = { taskId: number };

export type ResultCandidateSession = {
  sessionId: string;
  filename: string;
  fields: DisplayFields;
  analysis: Analysis;
  display: DisplayConfig;
};
export type ConfirmResultSessionRequest = { sessionId: string };
export type ConfirmResultSessionResponse = {
  confirmed: boolean;
  activeSessionId: string | null;
};
export type SaveResultFieldsRequest = {
  sessionId: string;
  fields: DisplayFields;
};
export type SavedResultFields = { sessionId: string; display: DisplayConfig };
export type DiscardResultDraftRequest = { sessionId: string };

/** Named invoke arguments. Command failures reject with DesktopError. */
export type DesktopCommands = {
  open_app_link: { args: { link: AppLink }; result: void };
  list_configs: { args: undefined; result: InstalledConfig[] };
  get_config_repository_state: {
    args: undefined;
    result: ConfigRepositoryState;
  };
  refresh_config_repository: {
    args: { force?: boolean } | undefined;
    result: ConfigRepositoryState;
  };
  install_config: { args: { id: string }; result: ConfigRepositoryState };
  update_config: { args: { id: string }; result: ConfigRepositoryState };
  uninstall_config: { args: { id: string }; result: ConfigRepositoryState };
  select_local_config_directory: {
    args: undefined;
    result: ConfigRepositoryState;
  };
  get_logical_cpu_count: { args: undefined; result: number };
  get_simulation_state: { args: undefined; result: SimulationTaskSnapshot };
  start_simulation: {
    args: { request: SimulationCommandRequest };
    result: SimulationTaskSnapshot;
  };
  cancel_simulation: {
    args: { request: CancelSimulationRequest };
    result: SimulationTaskSnapshot;
  };
  open_results_directory: { args: undefined; result: void };
  select_gsr_result: { args: undefined; result: ResultCandidateSession | null };
  open_simulation_result: { args: undefined; result: ResultCandidateSession };
  confirm_result_session: {
    args: { request: ConfirmResultSessionRequest };
    result: ConfirmResultSessionResponse;
  };
  save_result_fields: {
    args: { request: SaveResultFieldsRequest };
    result: SavedResultFields;
  };
  discard_result_draft: {
    args: { request: DiscardResultDraftRequest };
    result: void;
  };
};
export type DesktopCommand = keyof DesktopCommands;
export type DesktopArgs<C extends DesktopCommand> = DesktopCommands[C]["args"];
export type DesktopResponse<C extends DesktopCommand> =
  DesktopCommands[C]["result"];
export type DesktopEvents = { [SIMULATION_EVENT_NAME]: SimulationTaskEvent };

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return value as Record<string, unknown>;
}

function safeInteger(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function windowsDevice(stem: string): boolean {
  return /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])$/i.test(
    stem.replace(/ +$/, ""),
  );
}

function safeFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[. ]$|[<>:"/\\|?*]/.test(value) &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 31) &&
    !windowsDevice(value.split(".", 1)[0])
  );
}

function isU64Decimal(value: unknown): value is U64Decimal {
  return (
    typeof value === "string" &&
    value.length <= 20 &&
    /^(?:0|[1-9][0-9]*)$/.test(value) &&
    BigInt(value) <= 0xffff_ffff_ffff_ffffn
  );
}

export function validateSimulationCommandRequest(
  value: unknown,
  maxThreads: number,
): SimulationCommandRequest {
  const request = exactObject(
    value,
    [
      "configSource",
      "configId",
      "termination",
      "resultItem",
      "totalRuns",
      "seed",
      "threads",
    ],
    "simulation request",
  );
  if (request.configSource !== "installed" && request.configSource !== "local")
    throw new Error("invalid configSource");
  if (
    typeof request.configId !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(request.configId) ||
    windowsDevice(request.configId)
  )
    throw new Error("invalid configId");
  if (!safeFilename(request.termination))
    throw new Error("termination must be a safe filename");
  if (
    typeof request.resultItem !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.resultItem)
  )
    throw new Error("resultItem must be an item identifier");
  if (!safeInteger(request.totalRuns, 1, MAX_RUNS))
    throw new Error(`totalRuns must be in 1..=${MAX_RUNS}`);
  if (!safeInteger(request.seed, Number.MIN_SAFE_INTEGER))
    throw new Error("seed must be a JavaScript safe integer");
  const limit = Math.min(maxThreads, MAX_DESKTOP_THREADS);
  if (
    !Number.isSafeInteger(maxThreads) ||
    !safeInteger(request.threads, 1, limit)
  )
    throw new Error(`threads must be in 1..=${limit}`);
  return value as SimulationCommandRequest;
}

export function validateSimulationTaskSnapshot(
  value: unknown,
): SimulationTaskSnapshot {
  const snapshot = exactObject(
    value,
    [
      "taskId",
      "seq",
      "status",
      "stage",
      "completedRuns",
      "totalRuns",
      "totalResult",
      "resultFilename",
      "message",
      "cancelRetryable",
    ],
    "simulation snapshot",
  );
  if (
    !(snapshot.taskId === null || safeInteger(snapshot.taskId, 1)) ||
    !safeInteger(snapshot.seq, 0) ||
    !SIMULATION_STATUSES.some((status) => status === snapshot.status) ||
    !(
      snapshot.stage === null ||
      SIMULATION_STAGES.some((stage) => stage === snapshot.stage)
    ) ||
    !safeInteger(snapshot.totalRuns, 0, MAX_RUNS) ||
    !safeInteger(snapshot.completedRuns, 0, snapshot.totalRuns) ||
    !(snapshot.totalResult === null || isU64Decimal(snapshot.totalResult)) ||
    !(
      snapshot.resultFilename === null || safeFilename(snapshot.resultFilename)
    ) ||
    !(snapshot.message === null || typeof snapshot.message === "string") ||
    typeof snapshot.cancelRetryable !== "boolean"
  ) {
    throw new Error("invalid simulation snapshot");
  }
  return value as SimulationTaskSnapshot;
}

export function validateSimulationTaskEvent(
  value: unknown,
): SimulationTaskEvent {
  const event = exactObject(
    value,
    ["taskId", "seq", "snapshot"],
    "simulation event",
  );
  const snapshot = validateSimulationTaskSnapshot(event.snapshot);
  if (
    snapshot.taskId === null ||
    event.taskId !== snapshot.taskId ||
    event.seq !== snapshot.seq
  )
    throw new Error("simulation event identity differs from its snapshot");
  return { taskId: snapshot.taskId, seq: snapshot.seq, snapshot };
}

export function displayConfigForMissingSidecar(
  resultItemName: string,
): DisplayConfig {
  return {
    display_version: 2,
    title: "标题待填写",
    target: "目标待填写",
    result_item_name: resultItemName,
    note: "MEAN 受极端值影响，P50 表示一半结果不超过该值，P95 表示 95% 结果不超过该值。MIN、MAX 受模拟次数影响，不代表理论极限。",
    subtitle: "副标题待填写",
    result_item_unit: "",
  };
}

export function validateDisplayConfig(value: unknown): DisplayConfig {
  const display = validate_display_config(value);
  if (
    new TextEncoder().encode(JSON.stringify(display)).byteLength >
    DISPLAY_CONFIG_JSON_BYTE_LIMIT
  )
    throw new Error("DisplayConfig sidecar exceeds 16 MiB");
  return display;
}

function assertAnalysisU64Bounds(analysis: Analysis): void {
  if (!isU64Decimal(analysis.totals.runs) || BigInt(analysis.totals.runs) < 1n)
    throw new Error("analysis totals.runs exceeds u64 range");
  if (!isU64Decimal(analysis.totals.result))
    throw new Error("analysis totals.result exceeds u64 range");
  for (const value of analysis.values) {
    if (!isU64Decimal(value))
      throw new Error("analysis values entry exceeds u64 range");
  }
  const statKeys = [
    "P5",
    "P25",
    "P50",
    "P75",
    "P95",
    "MIN",
    "MEAN",
    "MAX",
  ] as const;
  for (const key of statKeys) {
    if (!isU64Decimal(analysis.statistic[key]))
      throw new Error(`analysis statistic.${key} exceeds u64 range`);
  }
}

export function validateResultCandidateSession(
  value: unknown,
): ResultCandidateSession {
  const candidate = exactObject(
    value,
    ["sessionId", "filename", "fields", "analysis", "display"],
    "result candidate",
  );
  if (
    typeof candidate.sessionId !== "string" ||
    !candidate.sessionId ||
    !safeFilename(candidate.filename)
  )
    throw new Error("invalid result candidate identity");
  const fields = exactObject(
    candidate.fields,
    DISPLAY_FIELD_KEYS,
    "display fields",
  );
  if (
    !DISPLAY_FIELD_KEYS.every((key) => typeof fields[key] === "string") ||
    !fields.result_item_name
  )
    throw new Error("invalid display fields");
  const analysis = validate_analysis(candidate.analysis);
  assertAnalysisU64Bounds(analysis);
  const display = validateDisplayConfig(candidate.display);
  if (DISPLAY_FIELD_KEYS.some((key) => fields[key] !== display[key]))
    throw new Error("Result candidate fields differ from display");
  return {
    sessionId: candidate.sessionId,
    filename: candidate.filename,
    fields: candidate.fields as DisplayFields,
    analysis,
    display,
  };
}

function isCancelling(status: SimulationStatus): boolean {
  return status === "cancelling" || status === "cancelled";
}

/** Bind to the current task with a command response or get_simulation_state. */
export class SimulationClientTracker {
  #snapshot: Readonly<SimulationTaskSnapshot> = {
    taskId: null,
    seq: 0,
    status: "idle",
    stage: null,
    completedRuns: 0,
    totalRuns: 0,
    totalResult: null,
    resultFilename: null,
    message: null,
    cancelRetryable: false,
  };
  #cancelPending = false;
  #freezeReadings = false;
  #hydrated = false;
  #futureEvent: SimulationTaskEvent | null = null;

  get snapshot(): Readonly<SimulationTaskSnapshot> {
    return this.#snapshot;
  }

  /** Freeze readings before invoking cancel_simulation. */
  requestCancel(): CancelSimulationRequest | null {
    const { taskId, status, cancelRetryable } = this.#snapshot;
    if (
      taskId === null ||
      this.#cancelPending ||
      !(
        status === "starting" ||
        status === "running" ||
        status === "saving" ||
        cancelRetryable
      )
    )
      return null;
    this.#cancelPending = true;
    this.#freezeReadings = true;
    return { taskId };
  }

  applyEvent(event: SimulationTaskEvent): boolean {
    if (
      event.taskId !== event.snapshot.taskId ||
      event.seq !== event.snapshot.seq ||
      event.taskId < (this.#snapshot.taskId ?? 0) ||
      event.seq <= this.#snapshot.seq
    )
      return false;
    if (!this.#hydrated) {
      if (event.seq > (this.#futureEvent?.seq ?? 0)) this.#futureEvent = event;
      return false;
    }
    if (
      this.#cancelPending &&
      event.taskId === this.#snapshot.taskId &&
      this.#snapshot.status !== "cancelling" &&
      !isCancelling(event.snapshot.status)
    ) {
      if (event.seq > (this.#futureEvent?.seq ?? 0)) this.#futureEvent = event;
      return false;
    }
    const applied = this.reconcileSnapshot(event.snapshot, false);
    return this.replayFutureEvent() || applied;
  }

  reconcile(snapshot: SimulationTaskSnapshot): boolean {
    return this.reconcileHostSnapshot(snapshot, false);
  }

  /** After a cancel response, or after fetching fresh state on command rejection. */
  reconcileAfterCancel(snapshot: SimulationTaskSnapshot): boolean {
    return this.reconcileHostSnapshot(snapshot, true);
  }

  private reconcileHostSnapshot(
    snapshot: SimulationTaskSnapshot,
    cancelSettled: boolean,
  ): boolean {
    const applied = this.reconcileSnapshot(snapshot, cancelSettled);
    this.#hydrated = true;
    return this.replayFutureEvent() || applied;
  }

  private replayFutureEvent(): boolean {
    if (!this.#hydrated || this.#cancelPending || this.#futureEvent === null)
      return false;
    const future = this.#futureEvent;
    this.#futureEvent = null;
    return this.applyEvent(future);
  }

  private reconcileSnapshot(
    next: SimulationTaskSnapshot,
    cancelSettled: boolean,
  ): boolean {
    const current = this.#snapshot;
    const sameTask = current.taskId === next.taskId;
    if (
      next.seq < current.seq ||
      (next.seq === current.seq &&
        !(sameTask && cancelSettled && this.#cancelPending)) ||
      (next.taskId ?? 0) < (current.taskId ?? 0)
    )
      return false;

    const cancelling = isCancelling(next.status);
    const failedCleanup =
      sameTask && current.status === "cancelling" && next.status === "failed";
    if (sameTask) {
      if (
        current.status === "cancelled" ||
        current.status === "completed" ||
        current.status === "failed"
      )
        return false;
      if (
        !cancelling &&
        !failedCleanup &&
        (isCancelling(current.status) ||
          (this.#cancelPending && !cancelSettled))
      )
        return false;
    }

    this.#freezeReadings =
      sameTask && (cancelling || failedCleanup) && this.#freezeReadings;
    this.#snapshot = this.#freezeReadings
      ? {
          ...next,
          completedRuns: current.completedRuns,
          totalRuns: current.totalRuns,
          totalResult: current.totalResult,
          resultFilename: current.resultFilename,
        }
      : { ...next };
    this.#cancelPending = false;
    return true;
  }
}
