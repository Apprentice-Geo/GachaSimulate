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
  cancellingLocally: boolean;
  eventsConnected: boolean;
  error: string | null;
}>;

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
  private startInFlight = false;
  private startBaselineTaskId: number | null = null;
  private cancelInFlight = false;
  private state: TauriSimulationState = {
    snapshot: this.tracker.snapshot,
    startingLocally: false,
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
    this.state = {
      ...this.state,
      snapshot: this.tracker.snapshot,
      startingLocally: this.startInFlight,
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
            this.startInFlight &&
            next.taskId !== null &&
            next.taskId !== this.startBaselineTaskId
          ) {
            this.startInFlight = false;
          }
          const cancelSettledByEvent =
            next.status === "cancelling" ||
            next.status === "cancelled" ||
            next.status === "failed";
          this.emit({
            cancellingLocally: this.cancelInFlight && !cancelSettledByEvent,
            error: next.message,
          });
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
      this.startInFlight &&
      next.taskId !== null &&
      next.taskId !== this.startBaselineTaskId
    ) {
      this.startInFlight = false;
    }
    const cancelSettledBySnapshot =
      next.status === "cancelling" ||
      next.status === "cancelled" ||
      next.status === "failed";
    this.emit({
      cancellingLocally: this.cancelInFlight && !cancelSettledBySnapshot,
      error: next.message,
    });
  }

  async start(
    request: SimulationCommandRequest,
    maxThreads: number,
  ): Promise<boolean> {
    if (this.startInFlight) return false;
    try {
      validateSimulationCommandRequest(request, maxThreads);
    } catch (reason) {
      this.emit({ error: toDesktopError(reason).message });
      return false;
    }
    if (this.unlisten === null) {
      try {
        await this.connect();
      } catch (reason) {
        this.emit({ error: toDesktopError(reason).message });
        return false;
      }
    }
    const gen = this.connectionGen;
    this.startBaselineTaskId = this.tracker.snapshot.taskId;
    this.startInFlight = true;
    this.emit({ error: null });
    try {
      const snapshot = await this.client.startSimulation(request);
      this.startInFlight = false;
      if (gen !== this.connectionGen) {
        this.emit();
        return false;
      }
      this.tracker.reconcile(snapshot);
      this.emit({
        cancellingLocally: false,
        error: this.tracker.snapshot.message,
      });
      return true;
    } catch (reason) {
      this.startInFlight = false;
      this.emit({ error: toDesktopError(reason).message });
      return false;
    }
  }

  async cancel(): Promise<void> {
    const cancelRequest = this.tracker.requestCancel();
    if (!cancelRequest) return;
    this.cancelInFlight = true;
    this.emit({ cancellingLocally: true, error: null });
    try {
      const snapshot = await this.client.cancelSimulation(cancelRequest);
      this.cancelInFlight = false;
      this.tracker.reconcileAfterCancel(snapshot);
      this.emit({
        cancellingLocally: false,
        error: this.tracker.snapshot.message,
      });
    } catch (reason) {
      const cancelError = toDesktopError(reason);
      try {
        const fresh = await this.client.getSimulationState();
        this.cancelInFlight = false;
        this.tracker.reconcileAfterCancel(fresh);
        this.emit({
          cancellingLocally: false,
          error: this.tracker.snapshot.message ?? cancelError.message,
        });
      } catch {
        this.cancelInFlight = false;
        // Release the tracker's pending-cancel lock so the user can retry cancel
        // and any buffered terminal event can reconcile immediately.
        this.tracker.reconcileAfterCancel(this.tracker.snapshot);
        this.emit({
          cancellingLocally: false,
          error: this.tracker.snapshot.message ?? cancelError.message,
        });
      }
    }
  }
}
