import assert from "node:assert/strict";
import test from "node:test";
import type { CDFViewModel } from "../visualize/types/cdf";
import type { DesktopExportEvent } from "../shared/export_task";
import type { ResultSnapshot } from "./result_editor";
import { UserRequestAdmission } from "./request_admission";
import { ExportTaskCoordinator } from "./export_task";
import { ExportCancelledError } from "./export_host";

const snapshot = {
  session_id: "session",
  path: "C:\\results\\result.gsr",
  stem: "result",
  analysis: {},
  display: {},
  view_model: {} as CDFViewModel,
} as ResultSnapshot;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve_value, reject_value) => {
    resolve = resolve_value;
    reject = reject_value;
  });
  return { promise, resolve, reject };
}

class FakeHost {
  readonly completion = deferred<void>();
  readonly saved_artifacts: Array<{ format: "mp4" | "png"; path: string }> = [];
  readonly residual_paths: string[] = [];
  readonly cleanup_failed = false;
  cancelled = false;

  start(): Promise<void> {
    return this.completion.promise;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.completion.reject(new ExportCancelledError());
  }

  async inspect_residual_paths(): Promise<string[]> {
    return this.residual_paths;
  }
}

test("reservation synchronously blocks new requests and hands off without a gap", async () => {
  const admission = new UserRequestAdmission();
  const events: DesktopExportEvent[] = [];
  const ids = ["reservation", "rejected-reservation", "task"];
  const host = new FakeHost();
  const editor = {
    wait_for_pending_saves: async () => undefined,
    snapshot_now: () => snapshot,
  };
  const coordinator = new ExportTaskCoordinator(
    editor as never,
    admission,
    (event) => events.push(event),
    {
      random_uuid: () => ids.shift()!,
      host_factory: () => host as never,
    },
  );

  const accepted = coordinator.prepare({
    session_id: "session",
    formats: ["png"],
    base_name: "result",
  });
  assert.equal(accepted.reservation_id, "reservation");
  assert.throws(() => admission.admit("simulation"), /during export/);
  assert.throws(
    () =>
      coordinator.prepare({
        session_id: "session",
        formats: ["png"],
        base_name: "result",
      }),
    /already active/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    events.some(({ type }) => type === "preparation-ready"),
    true,
  );

  const task_id = coordinator.start_reserved_task("reservation", {
    png: "C:\\exports\\result.png",
  });
  assert.equal(task_id, "task");
  assert.throws(() => admission.admit("analysis"), /during export/);
  host.saved_artifacts.push({ format: "png", path: "C:\\exports\\result.png" });
  host.completion.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  admission.admit("analysis");
  assert.equal(events.at(-1)?.type, "completed");
});

test("preparation cancellation is acknowledged before snapshot work finishes", async () => {
  const admission = new UserRequestAdmission();
  const events: DesktopExportEvent[] = [];
  const pending = deferred<ResultSnapshot>();
  const coordinator = new ExportTaskCoordinator(
    {
      wait_for_pending_saves: () => pending.promise.then(() => undefined),
      snapshot_now: () => snapshot,
    } as never,
    admission,
    (event) => events.push(event),
    { random_uuid: () => "reservation" },
  );
  coordinator.prepare({
    session_id: "session",
    formats: ["mp4", "png"],
    base_name: "result",
  });
  const cancelling = coordinator.cancel({ reservation_id: "reservation" });
  assert.deepEqual(events.at(-1), {
    type: "preparation-status",
    reservation_id: "reservation",
    stage: "cancelling",
  });
  pending.resolve(snapshot);
  await cancelling;
  assert.equal(events.at(-1)?.type, "preparation-cancelled");
  admission.admit("simulation");
});

test("formal cancellation emits one cancelled terminal and releases admission", async () => {
  const admission = new UserRequestAdmission();
  const events: DesktopExportEvent[] = [];
  const ids = ["reservation", "task"];
  const host = new FakeHost();
  const coordinator = new ExportTaskCoordinator(
    {
      wait_for_pending_saves: async () => undefined,
      snapshot_now: () => snapshot,
    } as never,
    admission,
    (event) => events.push(event),
    {
      random_uuid: () => ids.shift()!,
      host_factory: () => host as never,
    },
  );
  coordinator.prepare({
    session_id: "session",
    formats: ["mp4"],
    base_name: "result",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  coordinator.start_reserved_task("reservation", {
    mp4: "C:\\exports\\result.mp4",
  });
  await coordinator.cancel({ task_id: "task" });
  assert.equal(host.cancelled, true);
  assert.equal(events.filter(({ type }) => type === "cancelled").length, 1);
  admission.admit("config-change");
});
