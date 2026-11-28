import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { DISPLAY_FIELD_KEYS } from "./result_editor";
import {
  DISPLAY_CONFIG_JSON_BYTE_LIMIT,
  MAX_RUNS,
  SIMULATION_EVENT_NAME,
  SimulationClientTracker,
  displayConfigForMissingSidecar,
  validateDisplayConfig,
  validateResultCandidateSession,
  validateSimulationCommandRequest,
  validateSimulationTaskEvent,
  validateSimulationTaskSnapshot,
  type ConfigRepositoryState,
  type DesktopArgs,
  type DesktopError,
  type DesktopEvents,
  type DesktopResponse,
} from "./tauri_desktop_contract";

const fixtures = resolve(
  __dirname,
  "../../crates/gachasimulate-desktop-contract/fixtures",
);

function fixture<T = unknown>(filename: string): T {
  return JSON.parse(readFileSync(resolve(fixtures, filename), "utf8")) as T;
}

function eventFixtures() {
  const raw = fixture<{
    cancelRace: {
      beforeCancel: unknown[];
      lateEvents: unknown[];
      cancellationEvents: unknown[];
    };
    pageSwitch: {
      newTaskStart: unknown;
      snapshot: unknown;
      deliveries: { event: unknown; applied: boolean }[];
    };
  }>("simulation-events.json");
  return {
    beforeCancel: raw.cancelRace.beforeCancel.map(validateSimulationTaskEvent),
    lateEvents: raw.cancelRace.lateEvents.map(validateSimulationTaskEvent),
    cancellationEvents: raw.cancelRace.cancellationEvents.map(
      validateSimulationTaskEvent,
    ),
    newTaskStart: validateSimulationTaskEvent(raw.pageSwitch.newTaskStart),
    remount: validateSimulationTaskSnapshot(raw.pageSwitch.snapshot),
    deliveries: raw.pageSwitch.deliveries.map(({ event, applied }) => ({
      event: validateSimulationTaskEvent(event),
      applied,
    })),
  };
}

test("repository state distinguishes local and installed configurations with the same ID", () => {
  const state: DesktopResponse<"get_config_repository_state"> =
    fixture<ConfigRepositoryState>("config-repository-state.json");
  const [installed, update] = state.official;
  const [local] = state.localConfigs;
  assert.equal(installed.id, local.id);
  assert.equal(installed.status, "installed");
  assert.equal(local.source, "local");
  assert.notEqual(installed.name, local.name);
  assert.equal(update.status, "updateAvailable");
  assert.equal(state.localDirectory, "C:\\Configs");
});

test("start request uses named Tauri arguments and validates Windows filenames and limits", () => {
  const sample = fixture("simulation-request.json");
  const args: DesktopArgs<"start_simulation"> = {
    request: validateSimulationCommandRequest(sample, 2),
  };
  assert.deepEqual(args.request, sample);
  for (const invalid of [
    { configSource: "remote" },
    { configId: "../example" },
    { configId: "nul" },
    { configId: "a".repeat(65) },
    { termination: "../termination.yaml" },
    { termination: "C:\\config\\termination.yaml" },
    { termination: "termination.yaml:alternate" },
    { termination: "COM¹.yaml" },
    { termination: ".." },
    { termination: "termination.yaml " },
    { termination: "termination\0.yaml" },
    { resultItem: "9score" },
    { resultItem: "draw-count" },
    { totalRuns: 0 },
    { totalRuns: MAX_RUNS + 1 },
    { seed: Number.MAX_SAFE_INTEGER + 1 },
    { threads: 0 },
    { threads: 257 },
    { path: "C:\\example" },
  ]) {
    assert.throws(() =>
      validateSimulationCommandRequest({ ...args.request, ...invalid }, 512),
    );
  }
  assert.throws(() => validateSimulationCommandRequest(sample, 1));
  assert.throws(() => validateSimulationCommandRequest(sample, 0));
  validateSimulationCommandRequest(
    { ...args.request, totalRuns: MAX_RUNS, threads: 256 },
    512,
  );
});

test("cancel freezes readings and suppresses late success before and after acceptance", () => {
  const { beforeCancel, lateEvents, cancellationEvents } = eventFixtures();
  const tracker = new SimulationClientTracker();
  const [started, ...progress] = beforeCancel;
  const [acceptance, retryable, retry, cancelled] = cancellationEvents;
  assert.equal(tracker.reconcile(started.snapshot), true);
  for (const event of progress) assert.equal(tracker.applyEvent(event), true);
  const request: DesktopArgs<"cancel_simulation"> = {
    request: tracker.requestCancel()!,
  };
  assert.deepEqual(request, { request: { taskId: started.taskId } });
  for (const event of lateEvents)
    assert.equal(tracker.applyEvent(event), false);
  assert.equal(tracker.reconcile(lateEvents[0].snapshot), false);
  assert.equal(tracker.snapshot.completedRuns, 1);
  assert.equal(tracker.snapshot.totalResult, null);

  assert.equal(tracker.reconcileAfterCancel(acceptance.snapshot), true);
  assert.equal(tracker.snapshot.status, "cancelling");
  assert.equal(tracker.applyEvent(lateEvents[1]), false);
  assert.equal(tracker.requestCancel(), null);
  assert.equal(tracker.applyEvent(retryable), true);
  const error = fixture<DesktopError>("desktop-error.json");
  assert.equal(error.code, "cleanupBlocked");
  assert.equal(error.message, tracker.snapshot.message);
  assert.equal(tracker.snapshot.cancelRetryable, true);
  assert.deepEqual(tracker.requestCancel(), request.request);
  assert.equal(tracker.applyEvent(retry), true);
  assert.equal(tracker.applyEvent(cancelled), true);
  assert.equal(tracker.snapshot.status, "cancelled");
  assert.equal(tracker.snapshot.completedRuns, 1);
  assert.equal(tracker.snapshot.totalResult, null);
  assert.equal(tracker.snapshot.cancelRetryable, false);
});

test("a cancel rejected after host completion can reconcile to the committed result", () => {
  const { beforeCancel, lateEvents } = eventFixtures();
  const tracker = new SimulationClientTracker();
  tracker.reconcile(beforeCancel.at(-1)!.snapshot);
  tracker.requestCancel();
  const [, completed] = lateEvents;
  assert.equal(tracker.applyEvent(completed), false);
  assert.equal(tracker.reconcileAfterCancel(completed.snapshot), true);
  assert.equal(tracker.snapshot.status, "completed");
  assert.equal(tracker.snapshot.totalResult, "9007199254740993");
});

test("a cleanup retry settles to the original simulation failure", () => {
  const { beforeCancel, cancellationEvents, lateEvents } = eventFixtures();
  const tracker = new SimulationClientTracker();
  const running = beforeCancel.at(-1)!.snapshot;
  const [, blocked, retry, finished] = cancellationEvents;
  const failure = "Simulation worker exited unsuccessfully";

  tracker.reconcile(running);
  assert.equal(
    tracker.applyEvent({
      ...blocked,
      snapshot: {
        ...blocked.snapshot,
        message: `${failure}\nCleanup must be retried. Worker cleanup timed out`,
      },
    }),
    true,
  );
  assert.equal(tracker.snapshot.status, "cancelling");
  assert.equal(tracker.snapshot.taskId, running.taskId);
  assert.equal(tracker.snapshot.cancelRetryable, true);
  assert.deepEqual(tracker.requestCancel(), { taskId: running.taskId });
  assert.equal(tracker.requestCancel(), null);
  const completed = lateEvents.at(-1)!;
  assert.equal(
    tracker.applyEvent({
      ...completed,
      seq: retry.seq,
      snapshot: { ...completed.snapshot, seq: retry.seq },
    }),
    false,
  );

  const failed = {
    ...finished.snapshot,
    status: "failed" as const,
    message: failure,
  };
  assert.equal(tracker.applyEvent({ ...finished, snapshot: failed }), true);
  assert.equal(tracker.reconcileAfterCancel(retry.snapshot), false);
  assert.deepEqual(tracker.snapshot, failed);
});

test("a remount reconciles from host state and rejects stale IDs and replayed sequence numbers", () => {
  const { remount, deliveries, beforeCancel } = eventFixtures();
  const tracker = new SimulationClientTracker();
  assert.equal(tracker.reconcile(remount), true);
  for (const { event, applied } of deliveries) {
    const payload: DesktopEvents[typeof SIMULATION_EVENT_NAME] = event;
    assert.equal(tracker.applyEvent(payload), applied);
  }
  assert.equal(tracker.reconcile(remount), false);
  assert.equal(tracker.reconcile(beforeCancel[2].snapshot), false);
  assert.equal(tracker.snapshot.taskId, remount.taskId);
  assert.equal(tracker.snapshot.completedRuns, 2);
  assert.equal(tracker.snapshot.totalResult, "9007199254740993");
});

test("a hydrated tracker accepts the next task event before the start response", () => {
  const { newTaskStart, deliveries, cancellationEvents } = eventFixtures();
  const tracker = new SimulationClientTracker();
  tracker.reconcile(cancellationEvents.at(-1)!.snapshot);
  const { event } = deliveries.at(-1)!;
  assert.equal(tracker.applyEvent(event), true);
  assert.equal(tracker.reconcile(newTaskStart.snapshot), false);
  assert.deepEqual(tracker.snapshot, event.snapshot);
});

test("a remount replays a buffered task 42 completion over a stale task 41 snapshot", () => {
  const { lateEvents, deliveries } = eventFixtures();
  const tracker = new SimulationClientTracker();
  const stale = lateEvents.at(-1)!.snapshot;
  const { event } = deliveries.at(-1)!;

  assert.equal(tracker.applyEvent(event), false);
  assert.equal(tracker.snapshot.status, "idle");
  assert.equal(tracker.reconcile(stale), true);
  assert.equal(tracker.snapshot.taskId, 42);
  assert.equal(tracker.snapshot.status, "completed");
  assert.deepEqual(tracker.snapshot, event.snapshot);
});

test("an idle host response hydrates a new tracker and replays its buffered event", () => {
  const { newTaskStart } = eventFixtures();
  const tracker = new SimulationClientTracker();
  const idle = tracker.snapshot;

  assert.equal(tracker.applyEvent(newTaskStart), false);
  assert.equal(tracker.reconcileAfterCancel(idle), true);
  assert.deepEqual(tracker.snapshot, newTaskStart.snapshot);
});

test("an idle host response hydrates a new tracker without buffered events", () => {
  const { newTaskStart } = eventFixtures();
  const tracker = new SimulationClientTracker();
  tracker.reconcile(tracker.snapshot);
  assert.equal(tracker.applyEvent(newTaskStart), true);
  assert.deepEqual(tracker.snapshot, newTaskStart.snapshot);
});

test("a terminal failure event arriving before the cancel reply is replayed after acceptance", () => {
  const { beforeCancel } = eventFixtures();
  const failureMessage = "Disk full while writing GSR chunk";
  const running = beforeCancel[2].snapshot;
  const retryAccepted = {
    ...running,
    seq: 10,
    status: "cancelling" as const,
    message: null,
    cancelRetryable: false,
  };
  const failedAfterCleanup = {
    taskId: 41,
    seq: 11,
    snapshot: {
      ...retryAccepted,
      seq: 11,
      status: "failed" as const,
      completedRuns: 2,
      message: failureMessage,
    },
  };

  // Case 1: cancel reply settles after the terminal failure event arrived.
  const tracker = new SimulationClientTracker();
  tracker.reconcile(beforeCancel[0].snapshot);
  assert.equal(tracker.applyEvent(beforeCancel[1]), true);
  assert.equal(tracker.applyEvent(beforeCancel[2]), true);
  assert.deepEqual(tracker.requestCancel(), { taskId: 41 });
  assert.equal(tracker.applyEvent(failedAfterCleanup), false);
  assert.equal(tracker.snapshot.status, "running");
  assert.equal(tracker.reconcileAfterCancel(retryAccepted), true);
  assert.equal(tracker.snapshot.status, "failed");
  assert.equal(tracker.snapshot.seq, 11);
  assert.equal(tracker.snapshot.completedRuns, 1);
  assert.equal(tracker.snapshot.message, failureMessage);

  // Case 2: cancelling event itself arrives before the RPC reply.
  const tracker2 = new SimulationClientTracker();
  tracker2.reconcile(running);
  assert.deepEqual(tracker2.requestCancel(), { taskId: 41 });
  assert.equal(tracker2.applyEvent(failedAfterCleanup), false);
  assert.equal(
    tracker2.applyEvent({ taskId: 41, seq: 10, snapshot: retryAccepted }),
    true,
  );
  assert.equal(tracker2.snapshot.status, "failed");
  assert.equal(tracker2.snapshot.seq, 11);
  assert.equal(tracker2.snapshot.message, failureMessage);
});

test("a completion event buffered during an unaccepted cancel is replayed after recovery", () => {
  const { beforeCancel, lateEvents } = eventFixtures();
  const tracker = new SimulationClientTracker();
  tracker.reconcile(beforeCancel[0].snapshot);
  assert.equal(tracker.applyEvent(beforeCancel[1]), true);
  assert.equal(tracker.applyEvent(beforeCancel[2]), true);
  assert.deepEqual(tracker.requestCancel(), { taskId: 41 });

  // Cancel invoke failed before host accepted it, meanwhile the task completed.
  const completed = lateEvents[1];
  assert.equal(tracker.applyEvent(completed), false);
  assert.equal(tracker.snapshot.status, "running");

  // Recovery state read captured an older running snapshot before completion.
  const recoveryRunning = lateEvents[0].snapshot;
  assert.equal(tracker.reconcileAfterCancel(recoveryRunning), true);
  assert.equal(tracker.snapshot.status, "completed");
  assert.equal(tracker.snapshot.seq, completed.seq);
  assert.equal(tracker.snapshot.totalResult, "9007199254740993");
});

test("simulation event and snapshot validation reject identity mismatch and noncanonical totals", () => {
  const { deliveries } = eventFixtures();
  const { event } = deliveries.at(-1)!;
  assert.throws(() =>
    validateSimulationTaskEvent({ ...event, seq: event.seq + 1 }),
  );
  assert.throws(() =>
    validateSimulationTaskEvent({ ...event, taskId: event.taskId + 1 }),
  );
  for (const totalResult of ["01", "18446744073709551616", 9007199254740992]) {
    assert.throws(() =>
      validateSimulationTaskSnapshot({ ...event.snapshot, totalResult }),
    );
  }
  assert.deepEqual(
    validateSimulationTaskSnapshot({
      ...event.snapshot,
      totalResult: "18446744073709551615",
    }).totalResult,
    "18446744073709551615",
  );
});

test("result candidate preserves the published Analysis and accepts per-session display saves", () => {
  const raw = fixture("result-candidate-large-total.json");
  const candidate: DesktopResponse<"open_simulation_result"> =
    validateResultCandidateSession(raw);
  assert.deepEqual(candidate, raw);
  assert.equal(candidate.analysis.totals.result, "9007199254740993");
  assert.equal(BigInt(candidate.analysis.totals.result), 9007199254740993n);
  assert.deepEqual(
    candidate.display,
    displayConfigForMissingSidecar(candidate.analysis.result_item.name),
  );

  const confirm: DesktopArgs<"confirm_result_session"> = {
    request: { sessionId: candidate.sessionId },
  };
  const request = fixture<DesktopArgs<"save_result_fields">["request"]>(
    "save-result-fields-request.json",
  );
  const saved = fixture<DesktopResponse<"save_result_fields">>(
    "saved-result-fields.json",
  );
  assert.equal(request.sessionId, confirm.request.sessionId);
  assert.equal(saved.sessionId, request.sessionId);
  assert.deepEqual(validateDisplayConfig(saved.display), {
    display_version: 2,
    ...request.fields,
  });
  assert.throws(() =>
    validateResultCandidateSession({ ...candidate, path: "C:\\private.gsr" }),
  );
});

test("result candidates reject differences between fields and display", () => {
  const candidate = validateResultCandidateSession(
    fixture("result-candidate-large-total.json"),
  );
  for (const key of DISPLAY_FIELD_KEYS) {
    assert.throws(
      () =>
        validateResultCandidateSession({
          ...candidate,
          fields: { ...candidate.fields, [key]: "different value" },
        }),
      /fields differ from display/,
      key,
    );
  }
  assert.throws(
    () =>
      validateResultCandidateSession({
        ...candidate,
        analysis: {
          ...candidate.analysis,
          totals: {
            ...candidate.analysis.totals,
            result: "18446744073709551616",
          },
        },
      }),
    /u64 range/,
  );
});

test("missing sidecars use the v0.3.2 default note", () => {
  assert.equal(
    displayConfigForMissingSidecar("积分").note,
    "MEAN 受极端值影响，P50 表示一半结果不超过该值，P95 表示 95% 结果不超过该值。MIN、MAX 受模拟次数影响，不代表理论极限。",
  );
});

test("DisplayConfig validation uses the v2 schema and a UTF-8 byte limit", () => {
  const display = displayConfigForMissingSidecar("积分");
  assert.throws(() =>
    validateDisplayConfig({ ...display, display_version: 1 }),
  );
  assert.throws(() =>
    validateDisplayConfig({ ...display, result_item_name: "" }),
  );
  assert.throws(() =>
    validateDisplayConfig({ ...display, result_item_unit: undefined }),
  );
  assert.throws(() => validateDisplayConfig({ ...display, analysis: {} }));

  display.note = "";
  const available =
    DISPLAY_CONFIG_JSON_BYTE_LIMIT - Buffer.byteLength(JSON.stringify(display));
  display.note =
    "字".repeat(Math.floor(available / 3)) + " ".repeat(available % 3);
  assert.equal(
    Buffer.byteLength(JSON.stringify(display)),
    DISPLAY_CONFIG_JSON_BYTE_LIMIT,
  );
  validateDisplayConfig(display);
  display.note += "字";
  assert.throws(() => validateDisplayConfig(display), /16 MiB/);
});
