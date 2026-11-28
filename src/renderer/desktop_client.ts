import {
  SHUTDOWN_ERROR_EVENT_NAME,
  SIMULATION_EVENT_NAME,
  validateDisplayConfig,
  validateResultCandidateSessionWithParsed,
  validateSimulationTaskEvent,
  validateSimulationTaskSnapshot,
  type AppLink,
  type CancelSimulationRequest,
  type ConfigRepositoryState,
  type ConfirmResultSessionRequest,
  type ConfirmResultSessionResponse,
  type DesktopCommand,
  type DesktopError,
  type DesktopErrorCode,
  type DiscardResultDraftRequest,
  type InstalledConfig,
  type ResultCandidateSession,
  type SaveResultFieldsRequest,
  type SavedResultFields,
  type SimulationCommandRequest,
  type SimulationTaskEvent,
  type SimulationTaskSnapshot,
} from "../shared/tauri_desktop_contract";
import { register_wire_parsed_analysis } from "../visualize/data/analysis";

export type TauriUnlisten = () => void;

export interface TauriTransport {
  invoke<T>(
    command: DesktopCommand,
    args?: Record<string, unknown>,
  ): Promise<T>;
  listen<T>(
    event: string,
    handler: (payload: T) => void,
  ): Promise<TauriUnlisten>;
}

export class DesktopCommandError extends Error {
  readonly code: DesktopErrorCode | "unknown";

  constructor(code: DesktopErrorCode | "unknown", message: string) {
    super(message);
    this.name = "DesktopCommandError";
    this.code = code;
  }
}

const KNOWN_ERROR_CODES = new Set<DesktopErrorCode>([
  "invalidRequest",
  "notFound",
  "conflict",
  "cancelled",
  "io",
  "compile",
  "repository",
  "simulation",
  "analysis",
  "sidecar",
  "cleanupBlocked",
  "internal",
  "notImplemented",
]);

export function toDesktopError(reason: unknown): DesktopCommandError {
  if (reason instanceof DesktopCommandError) return reason;
  if (reason && typeof reason === "object") {
    const record = reason as Partial<DesktopError> & { message?: unknown };
    if (
      typeof record.code === "string" &&
      KNOWN_ERROR_CODES.has(record.code as DesktopErrorCode) &&
      typeof record.message === "string"
    ) {
      return new DesktopCommandError(
        record.code as DesktopErrorCode,
        record.message,
      );
    }
    if (typeof record.message === "string") {
      return new DesktopCommandError("unknown", record.message);
    }
  }
  return new DesktopCommandError("unknown", String(reason));
}

export interface TauriDesktopClient {
  openAppLink(link: AppLink): Promise<void>;
  listConfigs(): Promise<InstalledConfig[]>;
  getConfigRepositoryState(): Promise<ConfigRepositoryState>;
  refreshConfigRepository(force?: boolean): Promise<ConfigRepositoryState>;
  installConfig(id: string): Promise<ConfigRepositoryState>;
  updateConfig(id: string): Promise<ConfigRepositoryState>;
  uninstallConfig(id: string): Promise<ConfigRepositoryState>;
  selectLocalConfigDirectory(): Promise<ConfigRepositoryState>;
  getLogicalCpuCount(): Promise<number>;
  getSimulationState(): Promise<SimulationTaskSnapshot>;
  startSimulation(
    request: SimulationCommandRequest,
  ): Promise<SimulationTaskSnapshot>;
  cancelSimulation(
    request: CancelSimulationRequest,
  ): Promise<SimulationTaskSnapshot>;
  openResultsDirectory(): Promise<void>;
  selectGsrResult(): Promise<ResultCandidateSession | null>;
  openSimulationResult(): Promise<ResultCandidateSession>;
  confirmResultSession(
    request: ConfirmResultSessionRequest,
  ): Promise<ConfirmResultSessionResponse>;
  saveResultFields(
    request: SaveResultFieldsRequest,
  ): Promise<SavedResultFields>;
  discardResultDraft(request: DiscardResultDraftRequest): Promise<void>;
  onSimulationEvent(
    listener: (event: SimulationTaskEvent) => void,
  ): Promise<TauriUnlisten>;
  onShutdownError?(
    listener: (error: DesktopCommandError) => void,
  ): Promise<TauriUnlisten>;
}

function validateSavedResultFields(value: unknown): SavedResultFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DesktopCommandError("sidecar", "invalid saved result payload");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || !record.sessionId) {
    throw new DesktopCommandError("sidecar", "invalid saved result sessionId");
  }
  return {
    sessionId: record.sessionId,
    display: validateDisplayConfig(record.display),
  };
}

function validateConfirmResponse(value: unknown): ConfirmResultSessionResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DesktopCommandError(
      "internal",
      "invalid result confirmation payload",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.confirmed !== "boolean" ||
    !(
      record.activeSessionId === null ||
      typeof record.activeSessionId === "string"
    )
  ) {
    throw new DesktopCommandError(
      "internal",
      "invalid result confirmation payload",
    );
  }
  return {
    confirmed: record.confirmed,
    activeSessionId: record.activeSessionId,
  };
}

export function createTauriDesktopClient(
  transport: TauriTransport,
): TauriDesktopClient {
  const call = async <T>(
    command: DesktopCommand,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    try {
      return await transport.invoke<T>(command, args);
    } catch (reason) {
      throw toDesktopError(reason);
    }
  };

  return {
    openAppLink: (link) => call<void>("open_app_link", { link }),
    listConfigs: () => call<InstalledConfig[]>("list_configs"),
    getConfigRepositoryState: () =>
      call<ConfigRepositoryState>("get_config_repository_state"),
    refreshConfigRepository: (force) =>
      call<ConfigRepositoryState>(
        "refresh_config_repository",
        force === undefined ? undefined : { force },
      ),
    installConfig: (id) =>
      call<ConfigRepositoryState>("install_config", { id }),
    updateConfig: (id) => call<ConfigRepositoryState>("update_config", { id }),
    uninstallConfig: (id) =>
      call<ConfigRepositoryState>("uninstall_config", { id }),
    selectLocalConfigDirectory: () =>
      call<ConfigRepositoryState>("select_local_config_directory"),
    getLogicalCpuCount: async () => {
      const count = await call<number>("get_logical_cpu_count");
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new DesktopCommandError("internal", "invalid logical CPU count");
      }
      return count;
    },
    getSimulationState: async () =>
      validateSimulationTaskSnapshot(
        await call<unknown>("get_simulation_state"),
      ),
    startSimulation: async (request) =>
      validateSimulationTaskSnapshot(
        await call<unknown>("start_simulation", { request }),
      ),
    cancelSimulation: async (request) =>
      validateSimulationTaskSnapshot(
        await call<unknown>("cancel_simulation", { request }),
      ),
    openResultsDirectory: () => call<void>("open_results_directory"),
    selectGsrResult: async () => {
      const raw = await call<unknown>("select_gsr_result");
      if (raw === null) return null;
      const { candidate, parsed } =
        validateResultCandidateSessionWithParsed(raw);
      register_wire_parsed_analysis(candidate.analysis, parsed);
      return candidate;
    },
    openSimulationResult: async () => {
      const { candidate, parsed } = validateResultCandidateSessionWithParsed(
        await call<unknown>("open_simulation_result"),
      );
      register_wire_parsed_analysis(candidate.analysis, parsed);
      return candidate;
    },
    confirmResultSession: async (request) =>
      validateConfirmResponse(
        await call<unknown>("confirm_result_session", { request }),
      ),
    saveResultFields: async (request) =>
      validateSavedResultFields(
        await call<unknown>("save_result_fields", { request }),
      ),
    discardResultDraft: (request) =>
      call<void>("discard_result_draft", { request }),
    onSimulationEvent: async (listener) => {
      try {
        return await transport.listen<unknown>(SIMULATION_EVENT_NAME, (raw) => {
          try {
            listener(validateSimulationTaskEvent(raw));
          } catch {
            // Ignore malformed wire events instead of crashing the UI loop.
          }
        });
      } catch (reason) {
        throw toDesktopError(reason);
      }
    },
    onShutdownError: async (listener) => {
      try {
        return await transport.listen<unknown>(
          SHUTDOWN_ERROR_EVENT_NAME,
          (raw) => {
            listener(toDesktopError(raw));
          },
        );
      } catch (reason) {
        throw toDesktopError(reason);
      }
    },
  };
}
