import assert from "node:assert/strict";
import test from "node:test";
import type {
  DesktopExportEvent,
  ExportCancelRequest,
  ExportDestinationSelection,
  ExportPreparationAccepted,
} from "../shared/export_task";
import {
  ExportWorkflowController,
  type ExportWorkflowApi,
} from "./export_workflow_controller";

const context = { session_id: "session", default_base_name: "example" };
const completed = {
  type: "completed",
  task_id: "task",
  saved: [{ format: "png", file_name: "example.png" }],
  failed: [],
  cleanup_status: "clean",
  residual_files: [],
} as const;

function terminal_event(blocked = false): DesktopExportEvent {
  return {
    ...completed,
    saved: [...completed.saved],
    failed: [],
    cleanup_status: blocked ? "blocked" : "clean",
    cleanup_message: blocked ? "backup locked" : undefined,
    residual_files: blocked ? ["example.backup.png"] : [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve_value, reject_value) => {
    resolve = resolve_value;
    reject = reject_value;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function workflow(overrides: Partial<ExportWorkflowApi> = {}) {
  const listeners = new Set<(event: DesktopExportEvent) => void>();
  const cancellations: ExportCancelRequest[] = [];
  let selections = 0;
  let preparations = 0;
  const api: ExportWorkflowApi = {
    prepareExport: async () => {
      preparations += 1;
      return { reservation_id: "reservation" };
    },
    selectExportDestination: async () => {
      selections += 1;
      return { status: "started", task_id: "task" };
    },
    confirmExportOverwrite: async () => ({
      status: "started",
      task_id: "task",
    }),
    cancelExport: async (request) => {
      cancellations.push(request);
    },
    retryExportCleanup: async () => undefined,
    openExportDirectory: async () => undefined,
    exitAfterExportCleanup: async () => undefined,
    ...overrides,
    onExportEvent: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const controller = new ExportWorkflowController(api);
  const disconnect = controller.connect();
  const emit = (event: DesktopExportEvent) => {
    for (const listener of listeners) listener(event);
  };
  const prepare = async () => {
    controller.open(context);
    await controller.start_preparation(context);
  };
  const ready = () =>
    emit({ type: "preparation-ready", reservation_id: "reservation" });
  const start = async () => {
    await prepare();
    ready();
    await flush();
    assert.equal(controller.get_snapshot().flow.phase, "started");
  };
  return {
    controller,
    api,
    emit,
    ready,
    prepare,
    start,
    disconnect,
    cancellations,
    selections: () => selections,
    preparations: () => preparations,
    listener_count: () => listeners.size,
  };
}

test("validation checks the whole form and repeated clicks prepare only once", async () => {
  const w = workflow();
  assert.equal(w.controller.open(null), false);
  w.controller.open(context);
  w.controller.set_base_name("invalid/name");
  w.controller.toggle_format("mp4");
  await w.controller.start_preparation(context);
  assert.match(w.controller.get_snapshot().validation_error!, /base name/);
  assert.equal(w.preparations(), 0);
  w.controller.set_base_name("example");
  w.controller.toggle_format("png");
  w.controller.set_base_name("updated");
  await w.controller.start_preparation(context);
  assert.match(w.controller.get_snapshot().validation_error!, /format/);
  assert.equal(w.preparations(), 0);
  w.controller.toggle_format("png");
  await Promise.all([
    w.controller.start_preparation(context),
    w.controller.start_preparation(context),
  ]);
  assert.equal(w.preparations(), 1);
  assert.equal(w.controller.get_snapshot().flow.phase, "preparing");
});

for (const kind of ["ready", "failed", "cancelled", "returned"] as const) {
  test(`preparation ${kind} before its IPC reply is reconciled with its identity`, async () => {
    const reply = deferred<ExportPreparationAccepted>();
    const w = workflow({ prepareExport: () => reply.promise });
    const pending = w.prepare();
    if (kind === "ready") w.ready();
    else if (kind === "failed")
      w.emit({
        type: "preparation-failed",
        reservation_id: "reservation",
        message: "snapshot failed",
      });
    else
      w.emit({
        type: "preparation-cancelled",
        reservation_id: "reservation",
        reason: kind === "returned" ? "destination-returned" : "cancelled",
      });
    assert.equal(w.selections(), 0);
    reply.resolve({ reservation_id: "reservation" });
    await pending;
    await flush();
    const state = w.controller.get_snapshot();
    if (kind === "ready") {
      assert.equal(state.flow.phase, "started");
      assert.equal(w.selections(), 1);
    } else if (kind === "returned") {
      assert.deepEqual(state.flow, {
        phase: "editing",
        editing_focus: "directory",
      });
    } else {
      assert.equal(state.flow.phase, "closed");
      assert.equal(
        state.notice?.kind,
        kind === "failed" ? "error" : "cancelled",
      );
    }
  });
}

test("cancel before the preparation reply waits for identity and terminal acknowledgement", async () => {
  const reply = deferred<ExportPreparationAccepted>();
  const w = workflow({ prepareExport: () => reply.promise });
  const pending = w.prepare();
  w.controller.cancel_or_return();
  w.ready();
  assert.equal(w.controller.get_snapshot().flow.phase, "cancelling");
  assert.equal(w.cancellations.length, 0);
  reply.resolve({ reservation_id: "reservation" });
  await pending;
  assert.deepEqual(w.cancellations, [
    { reservation_id: "reservation", reason: "cancelled" },
  ]);
  assert.equal(w.selections(), 0);
  assert.equal(w.controller.get_snapshot().flow.phase, "cancelling");
  w.emit({
    type: "preparation-cancelled",
    reservation_id: "reservation",
    reason: "cancelled",
  });
  assert.equal(w.controller.get_snapshot().flow.phase, "closed");
});

test("a rejected pending cancellation remains blocked and can be retried", async () => {
  const reply = deferred<ExportPreparationAccepted>();
  const w = workflow({
    prepareExport: () => reply.promise,
    cancelExport: async () => {
      throw new Error("cancel unavailable");
    },
  });
  const pending = w.prepare();
  w.controller.cancel_or_return();
  reply.resolve({ reservation_id: "reservation" });
  await pending;
  assert.equal(w.controller.get_snapshot().flow.phase, "preparing");
  assert.equal(
    w.controller.get_snapshot().notice?.message,
    "cancel unavailable",
  );
  w.controller.cancel_or_return();
  assert.equal(w.controller.get_snapshot().flow.phase, "cancelling");
  await flush();
});

test("returning from destination selection preserves input and ignores old results", async () => {
  const reply = deferred<ExportDestinationSelection>();
  const w = workflow({ selectExportDestination: () => reply.promise });
  w.controller.open(context);
  w.controller.set_base_name("changed");
  w.controller.toggle_format("mp4");
  await w.controller.start_preparation(context);
  w.ready();
  w.emit({
    type: "preparation-cancelled",
    reservation_id: "reservation",
    reason: "destination-returned",
  });
  assert.deepEqual(w.controller.get_snapshot().flow, {
    phase: "editing",
    editing_focus: "directory",
  });
  await w.controller.start_preparation(context);
  reply.resolve({ status: "overwrite-required", files: ["old.png"] });
  await flush();
  const state = w.controller.get_snapshot();
  assert.equal(state.flow.phase, "preparing");
  assert.equal(state.base_name, "changed");
  assert.deepEqual(state.formats, ["png"]);
});

test("overwrite return requests reservation release and keeps the modal until acknowledged", async () => {
  const w = workflow({
    selectExportDestination: async () => ({
      status: "overwrite-required",
      files: ["example.png"],
    }),
  });
  await w.prepare();
  w.ready();
  await flush();
  assert.equal(w.controller.get_snapshot().flow.phase, "confirming_overwrite");
  w.controller.cancel_or_return();
  assert.deepEqual(w.cancellations, [
    { reservation_id: "reservation", reason: "destination-returned" },
  ]);
  assert.equal(w.controller.get_snapshot().flow.phase, "cancelling");
  w.emit({
    type: "preparation-cancelled",
    reservation_id: "reservation",
    reason: "destination-returned",
  });
  assert.deepEqual(w.controller.get_snapshot().flow, {
    phase: "editing",
    editing_focus: "directory",
  });
});

for (const handoff of ["destination", "overwrite"] as const) {
  for (const ending of [
    "progress",
    "cancel_confirm",
    "cancelling",
    "completed",
    "cleanup",
  ] as const) {
    test(`late ${handoff} reply cannot regress ${ending}`, async () => {
      const reply = deferred<{ status: "started"; task_id: string }>();
      const w = workflow({
        selectExportDestination: () =>
          handoff === "destination"
            ? reply.promise
            : Promise.resolve({
                status: "overwrite-required",
                files: ["example.png"],
              }),
        confirmExportOverwrite: () => reply.promise,
      });
      await w.prepare();
      w.ready();
      await flush();
      const pending =
        handoff === "overwrite" ? w.controller.confirm_overwrite() : undefined;
      w.emit({
        type: "started",
        reservation_id: "reservation",
        task_id: "task",
        formats: ["png"],
        base_name: "example",
      });
      w.emit({
        type: "progress",
        task_id: "task",
        stage: "rendering",
        completed: 42,
        total: 60,
        png_written: true,
      });
      if (ending === "cancel_confirm" || ending === "cancelling")
        w.controller.cancel_or_return();
      if (ending === "cancelling") w.controller.confirm_cancel();
      if (ending === "completed" || ending === "cleanup")
        w.emit(terminal_event(ending === "cleanup"));
      const before = w.controller.get_snapshot();
      w.emit({
        type: "started",
        reservation_id: "reservation",
        task_id: "task",
        formats: ["png"],
        base_name: "example",
      });
      reply.resolve({ status: "started", task_id: "task" });
      await pending;
      await flush();
      assert.equal(w.controller.get_snapshot(), before);
    });
  }
}

test("cancel confirmation preserves progress, and acknowledged cancellation alone closes the modal", async () => {
  const w = workflow();
  await w.start();
  w.emit({
    type: "progress",
    task_id: "task",
    stage: "rendering",
    completed: 12,
    total: 60,
    png_written: true,
  });
  w.controller.cancel_or_return();
  w.emit({
    type: "progress",
    task_id: "task",
    stage: "rendering",
    completed: 13,
    total: 60,
  });
  w.controller.cancel_or_return();
  const running = w.controller.get_snapshot().flow;
  assert.equal(running.phase, "started");
  if (running.phase !== "started") throw new Error("expected running task");
  assert.equal(running.progress.completed, 13);
  assert.equal(running.png_written, true);
  w.controller.cancel_or_return();
  w.controller.confirm_cancel();
  assert.deepEqual(w.cancellations, [{ task_id: "task" }]);
  assert.equal(w.controller.get_snapshot().flow.phase, "cancelling");
  w.emit({
    type: "cancelled",
    task_id: "task",
    saved: [],
    failed: [],
    cleanup_status: "clean",
    residual_files: [],
  });
  assert.equal(w.controller.get_snapshot().flow.phase, "closed");
  assert.equal(w.controller.get_snapshot().notice?.kind, "cancelled");
});

test("task cancellation rejection retains the running task and allows another cancellation", async () => {
  let attempts = 0;
  const w = workflow({
    cancelExport: async () => {
      if (++attempts === 1) throw new Error("cancel unavailable");
    },
  });
  await w.start();
  w.emit({
    type: "progress",
    task_id: "task",
    stage: "rendering",
    completed: 12,
    total: 60,
  });
  w.controller.cancel_or_return();
  w.controller.confirm_cancel();
  await flush();
  const running = w.controller.get_snapshot().flow;
  assert.equal(running.phase, "started");
  if (running.phase !== "started") throw new Error("expected running task");
  assert.equal(running.progress.completed, 12);
  assert.equal(w.controller.open(context), false);
  w.controller.cancel_or_return();
  w.controller.confirm_cancel();
  await flush();
  assert.equal(attempts, 2);
  assert.equal(w.controller.get_snapshot().flow.phase, "cancelling");
});

test("partial success reports saved and failed formats and rejects unrelated events", async () => {
  const opened: string[] = [];
  const w = workflow({
    openExportDirectory: async ({ task_id }) => {
      opened.push(task_id);
    },
  });
  await w.start();
  const running = w.controller.get_snapshot();
  w.emit({
    type: "failed",
    task_id: "unrelated",
    message: "stale",
    saved: [],
    failed: [],
    cleanup_status: "clean",
    residual_files: [],
  });
  assert.equal(w.controller.get_snapshot(), running);
  w.emit({
    type: "failed",
    task_id: "task",
    message: "PNG failed",
    saved: [{ format: "mp4", file_name: "example.mp4" }],
    failed: ["png"],
    cleanup_status: "clean",
    residual_files: [],
  });
  assert.deepEqual(w.controller.get_snapshot().notice, {
    kind: "error",
    message: "PNG failed",
    task_id: "task",
    saved: ["mp4"],
    failed: ["png"],
  });
  await w.controller.open_directory();
  assert.deepEqual(opened, ["task"]);
});

test("cleanup terminal and completion can arrive consecutively without a React render", async () => {
  const w = workflow();
  await w.start();
  w.emit(terminal_event(true));
  w.controller.cancel_or_return();
  assert.equal(w.controller.open(context), false);
  assert.equal(w.controller.get_snapshot().flow.phase, "cleanup_blocked");
  const retry = w.controller.retry_cleanup();
  assert.equal(w.controller.get_snapshot().flow.phase, "cleanup_retrying");
  w.emit({ type: "cleanup-completed", task_id: "task" });
  await retry;
  assert.equal(w.controller.get_snapshot().flow.phase, "closed");
  assert.equal(
    w.controller.get_snapshot().notice?.message,
    "文件已保存，导出资源现已清理",
  );
  assert.deepEqual(w.controller.get_snapshot().notice?.saved, ["png"]);
  assert.equal(w.listener_count(), 1);
});

test("cleanup failures retain terminal details and a stale rejection cannot replace a newer retry", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  let attempts = 0;
  const w = workflow({
    retryExportCleanup: () =>
      ++attempts === 1 ? first.promise : second.promise,
  });
  await w.start();
  w.emit(terminal_event(true));
  const retry_one = w.controller.retry_cleanup();
  w.emit({
    type: "cleanup-failed",
    task_id: "task",
    message: "still locked",
    residual_files: ["other.backup.png"],
  });
  const retry_two = w.controller.retry_cleanup();
  first.reject(new Error("old failure"));
  await retry_one;
  assert.equal(w.controller.get_snapshot().flow.phase, "cleanup_retrying");
  second.reject(new Error("new failure"));
  await retry_two;
  const flow = w.controller.get_snapshot().flow;
  assert.equal(flow.phase, "cleanup_blocked");
  if (flow.phase !== "cleanup_blocked")
    throw new Error("expected blocked cleanup");
  assert.equal(flow.cleanup_error, "new failure");
  assert.deepEqual(flow.residual_files, ["other.backup.png"]);
  assert.deepEqual(flow.terminal.saved, completed.saved);
});

test("old directory errors and notice timeouts do not replace a new workflow", async () => {
  const reply = deferred<void>();
  const w = workflow({ openExportDirectory: () => reply.promise });
  await w.start();
  w.emit(terminal_event());
  const old_notice = w.controller.get_snapshot().notice;
  const pending = w.controller.open_directory();
  w.controller.open(context);
  reply.reject(new Error("old directory failure"));
  await pending;
  w.controller.dismiss_notice(old_notice);
  assert.equal(w.controller.get_snapshot().notice, null);
  assert.equal(w.controller.get_snapshot().flow.phase, "editing");
});

test("disconnect removes IPC subscription and invalidates outstanding replies", async () => {
  const reply = deferred<ExportPreparationAccepted>();
  const w = workflow({ prepareExport: () => reply.promise });
  const pending = w.prepare();
  const before = w.controller.get_snapshot();
  w.disconnect();
  assert.equal(w.listener_count(), 0);
  w.ready();
  reply.resolve({ reservation_id: "reservation" });
  await pending;
  assert.equal(w.controller.get_snapshot(), before);
  assert.equal(w.selections(), 0);
  const disconnect = w.controller.connect();
  assert.equal(w.listener_count(), 1);
  disconnect();
});
