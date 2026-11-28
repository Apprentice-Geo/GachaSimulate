import {
  SimulationClientTracker,
  validateSimulationCommandRequest,
  type SimulationCommandRequest,
  type SimulationTaskSnapshot,
} from "../shared/tauri_desktop_contract";
import {
  toDesktopError,
  type TauriDesktopClient,
  type TauriUnlisten,
} from "./desktop_client";

export type TauriSimulationState = Readonly<{
  snapshot: Readonly<SimulationTaskSnapshot>;
  startingLocally: boolean;
  startBusy: boolean;
  cancellingLocally: boolean;
  eventsConnected: boolean;
  error: string | null;
}>;

function isCancelSettledForPending(
  snapshot: Readonly<SimulationTaskSnapshot>,
  pending: { taskId: number; baselineSeq: number },
): boolean {
  if (snapshot.taskId !== pending.taskId) return true;
  if (snapshot.seq <= pending.baselineSeq) return false;
  return (
    snapshot.status === "cancelled" ||
    snapshot.status === "failed" ||
    (snapshot.status === "cancelling" && !snapshot.cancelRetryable)
  );
}

/**
 * App-owned simulation controller that binds to the host's sequenced task
 * state, freezes readings immediately on cancel, and reconciles cleanly across
 * page switches, React Strict Mode reconnects, and remounts.
 */
export class TauriSimulationController {
  private readonly tracker = new SimulationClientTracker();
  private readonly listeners = new Set<() => void>();
  private unlisten: TauriUnlisten | null = null;
  private connectionGen = 0;
  private startLocked = false;
  private startAwaitingEvent = false;
  private startBaselineTaskId: number | null = null;
  private pendingCancel: { taskId: number; baselineSeq: number } | null = null;
  private state: TauriSimulationState = {
    snapshot: this.tracker.snapshot,
    startingLocally: false,
    startBusy: false,
    cancellingLocally: false,
    eventsConnected: false,
    error: null,
  };

  constructor(
    private readonly client: Pick<
      TauriDesktopClient,
      | "getSimulationState"
      | "startSimulation"
      | "cancelSimulation"
      | "onSimulationEvent"
    >,
  ) {}

  get_snapshot = (): TauriSimulationState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private emit(patch: Partial<TauriSimulationState> = {}): void {
    const snapshot = this.tracker.snapshot;
    this.state = {
      ...this.state,
      snapshot,
      startingLocally: this.startAwaitingEvent,
      startBusy: this.startLocked,
      cancellingLocally:
        this.pendingCancel !== null &&
        !isCancelSettledForPending(snapshot, this.pendingCancel),
      eventsConnected: this.unlisten !== null,
      ...patch,
    };
    for (const listener of this.listeners) listener();
  }

  /** Subscribes to live host events and hydrates from authoritative host state. */
  async connect(): Promise<void> {
    const gen = ++this.connectionGen;
    this.unlisten?.();
    this.unlisten = null;
    try {
      const unlisten = await this.client.onSimulationEvent((event) => {
        if (gen !== this.connectionGen) return;
        if (this.tracker.applyEvent(event)) {
          const next = this.tracker.snapshot;
          if (
            this.startAwaitingEvent &&
            next.taskId !== null &&
            next.taskId !== this.startBaselineTaskId
          ) {
            this.startAwaitingEvent = false;
          }
          this.emit({ error: next.message });
        }
      });
      if (gen !== this.connectionGen) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      this.emit();
    } catch (reason) {
      if (gen !== this.connectionGen) return;
      this.emit({ error: toDesktopError(reason).message });
      throw reason;
    }
    await this.refresh_from_host(gen);
  }

  async ensure_connected(): Promise<void> {
    if (this.unlisten === null) {
      await this.connect();
      return;
    }
    await this.refresh_from_host();
  }

  disconnect(): void {
    this.connectionGen += 1;
    this.unlisten?.();
    this.unlisten = null;
  }

  async refresh_from_host(expectedGen = this.connectionGen): Promise<void> {
    const fresh = await this.client.getSimulationState();
    if (expectedGen !== this.connectionGen) return;
    this.tracker.reconcile(fresh);
    const next = this.tracker.snapshot;
    if (
      this.startAwaitingEvent &&
      next.taskId !== null &&
      next.taskId !== this.startBaselineTaskId
    ) {
      this.startAwaitingEvent = false;
    }
    this.emit({ error: next.message });
  }

  async start(
    request: SimulationCommandRequest,
    maxThreads: number,
  ): Promise<boolean> {
    if (this.startLocked) return false;
    try {
      validateSimulationCommandRequest(request, maxThreads);
    } catch (reason) {
      this.emit({ error: toDesktopError(reason).message });
      return false;
    }
    this.startLocked = true;
    this.startBaselineTaskId = this.tracker.snapshot.taskId;
    this.startAwaitingEvent = true;
    this.emit({ error: null });
    try {
      if (this.unlisten === null) {
        await this.connect();
        this.startBaselineTaskId = this.tracker.snapshot.taskId;
      }
      const gen = this.connectionGen;
      const snapshot = await this.client.startSimulation(request);
      this.startAwaitingEvent = false;
      if (gen !== this.connectionGen) {
        this.emit();
        return false;
      }
      this.tracker.reconcile(snapshot);
      this.emit({ error: this.tracker.snapshot.message });
      return true;
    } catch (reason) {
      this.startAwaitingEvent = false;
      this.emit({ error: toDesktopError(reason).message });
      return false;
    } finally {
      this.startLocked = false;
      this.startAwaitingEvent = false;
      this.emit();
    }
  }

  async cancel(): Promise<void> {
    const cancelRequest = this.tracker.requestCancel();
    if (!cancelRequest) return;
    const pending = {
      taskId: cancelRequest.taskId,
      baselineSeq: this.tracker.snapshot.seq,
    };
    this.pendingCancel = pending;
    this.emit({ error: null });
    try {
      const snapshot = await this.client.cancelSimulation(cancelRequest);
      if (this.pendingCancel === pending) this.pendingCancel = null;
      this.tracker.reconcileAfterCancel(snapshot);
      this.emit({ error: this.tracker.snapshot.message });
    } catch (reason) {
      const cancelError = toDesktopError(reason);
      try {
        const fresh = await this.client.getSimulationState();
        if (this.pendingCancel === pending) this.pendingCancel = null;
        this.tracker.reconcileAfterCancel(fresh);
        this.emit({
          error: this.tracker.snapshot.message ?? cancelError.message,
        });
      } catch {
        if (this.pendingCancel === pending) this.pendingCancel = null;
        // Release the tracker's pending-cancel lock so the user can retry cancel
        // and any buffered terminal event or snapshot can reconcile immediately.
        this.tracker.reconcileAfterCancel(this.tracker.snapshot);
        this.emit({
          error: this.tracker.snapshot.message ?? cancelError.message,
        });
      }
    }
  }
}
