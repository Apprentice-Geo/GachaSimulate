import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SIMULATION_EVENT_NAME,
  displayConfigForMissingSidecar,
  type DesktopCommand,
  type ResultCandidateSession,
  type SimulationCommandRequest,
  type SimulationTaskEvent,
  type SimulationTaskSnapshot,
} from "../shared/tauri_desktop_contract";
import {
  DesktopCommandError,
  createTauriDesktopClient,
  type TauriTransport,
} from "./desktop_client";
import { TauriSimulationController } from "./tauri_simulation_controller";
import { TauriResultSessionController } from "./tauri_result_session_controller";
import { ResultSummaryPage } from "./pages/ResultSummaryPage";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "commonjs", source: "", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const CONTRACT_FIXTURES = resolve(
  __dirname,
  "../../crates/gachasimulate-desktop-contract/fixtures",
);

function load_fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(resolve(CONTRACT_FIXTURES, name), "utf8"),
  ) as T;
}

function create_mock_transport(
  handlers: Partial<
    Record<DesktopCommand, (args?: Record<string, unknown>) => unknown>
  >,
) {
  const calls: Array<{
    command: DesktopCommand;
    args?: Record<string, unknown>;
  }> = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  const transport: TauriTransport = {
    async invoke<T>(command: DesktopCommand, args?: Record<string, unknown>) {
      calls.push({ command, args });
      const handler = handlers[command];
      if (!handler) throw { code: "notImplemented", message: command };
      return (await handler(args)) as T;
    },
    async listen<T>(event: string, handler: (payload: T) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const wrapped = handler as (payload: unknown) => void;
      set.add(wrapped);
      return () => {
        set?.delete(wrapped);
      };
    },
  };

  return {
    transport,
    calls,
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
  };
}

const SAMPLE_REQUEST: SimulationCommandRequest = {
  configSource: "local",
  configId: "example",
  termination: "termination.yaml",
  resultItem: "score",
  totalRuns: 2,
  seed: 123,
  threads: 2,
};

test("TauriDesktopClient maps commands to named Tauri arguments and normalizes DesktopError", async () => {
  const repoState = load_fixture("config-repository-state.json");
  const candidate = load_fixture<ResultCandidateSession>(
    "result-candidate-large-total.json",
  );
  const mock = create_mock_transport({
    list_configs: () => [],
    get_config_repository_state: () => repoState,
    refresh_config_repository: () => repoState,
    install_config: () => repoState,
    get_logical_cpu_count: () => 8,
    open_app_link: () => undefined,
    open_simulation_result: () => candidate,
    confirm_result_session: () => ({
      confirmed: true,
      activeSessionId: candidate.sessionId,
    }),
    uninstall_config: () => {
      throw { code: "conflict", message: "simulation is active" };
    },
  });
  const client = createTauriDesktopClient(mock.transport);

  assert.deepEqual(await client.listConfigs(), []);
  assert.equal(await client.getLogicalCpuCount(), 8);
  await client.refreshConfigRepository(true);
  await client.installConfig("example");
  await client.openAppLink("project");
  const opened = await client.openSimulationResult();
  assert.equal(opened.analysis.totals.result, "9007199254740993");

  assert.deepEqual(mock.calls[2], {
    command: "refresh_config_repository",
    args: { force: true },
  });
  assert.deepEqual(mock.calls[3], {
    command: "install_config",
    args: { id: "example" },
  });
  assert.deepEqual(mock.calls[4], {
    command: "open_app_link",
    args: { link: "project" },
  });

  await assert.rejects(
    () => client.uninstallConfig("example"),
    (error: unknown) =>
      error instanceof DesktopCommandError &&
      error.code === "conflict" &&
      error.message === "simulation is active",
  );
});

test("TauriSimulationController freezes readings on cancel and suppresses late completion", async () => {
  const events = load_fixture<{
    cancelRace: {
      beforeCancel: SimulationTaskEvent[];
      lateEvents: SimulationTaskEvent[];
      cancellationEvents: SimulationTaskEvent[];
    };
  }>("simulation-events.json");

  let resolveCancel!: (snapshot: SimulationTaskSnapshot) => void;
  const idle: SimulationTaskSnapshot = {
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

  const mock = create_mock_transport({
    get_simulation_state: () => idle,
    start_simulation: () => events.cancelRace.beforeCancel[0].snapshot,
    cancel_simulation: () =>
      new Promise<SimulationTaskSnapshot>((resolvePromise) => {
        resolveCancel = resolvePromise;
      }),
  });
  const controller = new TauriSimulationController(
    createTauriDesktopClient(mock.transport),
  );
  await controller.connect();

  assert.equal(await controller.start(SAMPLE_REQUEST, 8), true);
  mock.emit(SIMULATION_EVENT_NAME, events.cancelRace.beforeCancel[1]);
  mock.emit(SIMULATION_EVENT_NAME, events.cancelRace.beforeCancel[2]);
  assert.equal(controller.get_snapshot().snapshot.completedRuns, 1);

  const cancelPromise = controller.cancel();
  assert.equal(controller.get_snapshot().cancellingLocally, true);

  // Late progress and late completion arrive simultaneously with cancel.
  mock.emit(SIMULATION_EVENT_NAME, events.cancelRace.lateEvents[0]);
  mock.emit(SIMULATION_EVENT_NAME, events.cancelRace.lateEvents[1]);
  assert.equal(controller.get_snapshot().snapshot.completedRuns, 1);
  assert.equal(controller.get_snapshot().snapshot.status, "running");

  // Host accepts cancellation; late completion must stay suppressed.
  resolveCancel(events.cancelRace.cancellationEvents[0].snapshot);
  await cancelPromise;
  assert.equal(controller.get_snapshot().cancellingLocally, false);
  assert.equal(controller.get_snapshot().snapshot.status, "cancelling");
  assert.equal(controller.get_snapshot().snapshot.completedRuns, 1);

  // Cleanup retry blocked -> retryable -> cancelled.
  mock.emit(SIMULATION_EVENT_NAME, events.cancelRace.cancellationEvents[1]);
  assert.equal(controller.get_snapshot().snapshot.cancelRetryable, true);
  mock.emit(SIMULATION_EVENT_NAME, events.cancelRace.cancellationEvents[2]);
  mock.emit(SIMULATION_EVENT_NAME, events.cancelRace.cancellationEvents[3]);
  assert.equal(controller.get_snapshot().snapshot.status, "cancelled");
  assert.equal(controller.get_snapshot().snapshot.completedRuns, 1);
  controller.disconnect();
});

test("TauriSimulationController ignores stale previous-task progress after remount", async () => {
  const events = load_fixture<{
    pageSwitch: {
      snapshot: SimulationTaskSnapshot;
      deliveries: Array<{ event: SimulationTaskEvent; applied: boolean }>;
    };
  }>("simulation-events.json");

  const mock = create_mock_transport({
    get_simulation_state: () => events.pageSwitch.snapshot,
  });
  const controller = new TauriSimulationController(
    createTauriDesktopClient(mock.transport),
  );
  await controller.connect();

  assert.equal(controller.get_snapshot().snapshot.taskId, 42);
  for (const delivery of events.pageSwitch.deliveries) {
    mock.emit(SIMULATION_EVENT_NAME, delivery.event);
  }
  const final = controller.get_snapshot().snapshot;
  assert.equal(final.taskId, 42);
  assert.equal(final.status, "completed");
  assert.equal(final.totalResult, "9007199254740993");
  controller.disconnect();
});

test("TauriSimulationController recovers to failed outcome when cancel fails or cleanup retries", async () => {
  const events = load_fixture<{
    cancelRace: { beforeCancel: SimulationTaskEvent[] };
  }>("simulation-events.json");
  const running = events.cancelRace.beforeCancel[2].snapshot;
  const failed: SimulationTaskSnapshot = {
    ...running,
    seq: 4,
    status: "failed",
    message: "disk full",
  };
  let stateCalls = 0;
  const mock = create_mock_transport({
    get_simulation_state: () => {
      stateCalls += 1;
      return stateCalls === 1 ? running : failed;
    },
    cancel_simulation: () => {
      throw { code: "conflict", message: "task already failed" };
    },
  });
  const controller = new TauriSimulationController(
    createTauriDesktopClient(mock.transport),
  );
  await controller.connect();
  await controller.cancel();
  assert.equal(controller.get_snapshot().snapshot.status, "failed");
  assert.equal(controller.get_snapshot().error, "disk full");
  controller.disconnect();
});

test("TauriSimulationController restores cancellation after double failure, supports Strict Mode reconnect, keeps cancellingLocally across refresh, and guards in-flight start", async () => {
  const events = load_fixture<{
    cancelRace: {
      beforeCancel: SimulationTaskEvent[];
      cancellationEvents: SimulationTaskEvent[];
    };
  }>("simulation-events.json");
  const running = events.cancelRace.beforeCancel[2].snapshot;

  let failState = false;
  let cancelCalls = 0;
  let resolveCancel!: (snapshot: SimulationTaskSnapshot) => void;
  let resolveStart!: (snapshot: SimulationTaskSnapshot) => void;
  let startCalls = 0;

  const mock = create_mock_transport({
    get_simulation_state: () => {
      if (failState) throw { code: "io", message: "ipc lost" };
      return running;
    },
    start_simulation: () => {
      startCalls += 1;
      return new Promise<SimulationTaskSnapshot>((r) => {
        resolveStart = r;
      });
    },
    cancel_simulation: () => {
      cancelCalls += 1;
      if (cancelCalls === 1)
        throw { code: "io", message: "cancel transport error" };
      return new Promise<SimulationTaskSnapshot>((r) => {
        resolveCancel = r;
      });
    },
  });
  const controller = new TauriSimulationController(
    createTauriDesktopClient(mock.transport),
  );

  // Strict Mode double-mount: connect -> disconnect -> connect still receives events.
  await controller.connect();
  controller.disconnect();
  await controller.connect();
  assert.equal(controller.get_snapshot().snapshot.taskId, 41);

  // Double failure on cancel + fallback state read must unlock retryable cancel.
  failState = true;
  await controller.cancel();
  assert.equal(cancelCalls, 1);
  assert.equal(controller.get_snapshot().cancellingLocally, false);
  assert.match(controller.get_snapshot().error ?? "", /cancel transport error/);

  // Second cancel succeeds; pre-cancel refresh_from_host must keep cancellingLocally true.
  failState = false;
  const secondCancel = controller.cancel();
  assert.equal(cancelCalls, 2);
  assert.equal(controller.get_snapshot().cancellingLocally, true);
  await controller.refresh_from_host();
  assert.equal(controller.get_snapshot().cancellingLocally, true);

  resolveCancel(events.cancelRace.cancellationEvents[0].snapshot);
  await secondCancel;
  assert.equal(controller.get_snapshot().cancellingLocally, false);
  assert.equal(controller.get_snapshot().snapshot.status, "cancelling");

  // Re-entrant start while first start is pending sends only one invoke, and
  // a new-task event arriving before the start reply unlocks cancellation immediately.
  const startController = new TauriSimulationController(
    createTauriDesktopClient(mock.transport),
  );
  await startController.connect();
  const firstStart = startController.start(SAMPLE_REQUEST, 8);
  assert.equal(startController.get_snapshot().startingLocally, true);
  assert.equal(await startController.start(SAMPLE_REQUEST, 8), false);
  assert.equal(startCalls, 1);
  // New task 42 starts before the start_simulation RPC returns.
  mock.emit(SIMULATION_EVENT_NAME, {
    taskId: 42,
    seq: 9,
    snapshot: { ...running, taskId: 42, seq: 9, status: "running" },
  });
  assert.equal(startController.get_snapshot().startingLocally, false);
  assert.equal(startController.get_snapshot().snapshot.taskId, 42);
  resolveStart({ ...running, taskId: 42, seq: 9, status: "running" });
  assert.equal(await firstStart, true);

  // Failed event subscription surfaces error and retries before starting a run.
  let listenAttempts = 0;
  let startedAfterReconnect = false;
  const flakyTransport: TauriTransport = {
    async invoke<T>(command: DesktopCommand) {
      if (command === "get_simulation_state") return running as T;
      if (command === "start_simulation") {
        startedAfterReconnect = true;
        return events.cancelRace.beforeCancel[0].snapshot as T;
      }
      throw { code: "notImplemented", message: command };
    },
    async listen() {
      listenAttempts += 1;
      if (listenAttempts === 1) {
        throw { code: "internal", message: "event bus unavailable" };
      }
      return () => undefined;
    },
  };
  const flakyController = new TauriSimulationController(
    createTauriDesktopClient(flakyTransport),
  );
  await assert.rejects(
    () => flakyController.connect(),
    /event bus unavailable/,
  );
  assert.equal(flakyController.get_snapshot().eventsConnected, false);
  assert.match(
    flakyController.get_snapshot().error ?? "",
    /event bus unavailable/,
  );
  assert.equal(await flakyController.start(SAMPLE_REQUEST, 8), true);
  assert.equal(listenAttempts, 2);
  assert.equal(startedAfterReconnect, true);
  assert.equal(flakyController.get_snapshot().eventsConnected, true);

  controller.disconnect();
  startController.disconnect();
  flakyController.disconnect();
});

test("TauriSimulationController preserves pending cancel across late start reply, replays deferred reconnect completion, and locks concurrent starts during listener setup", async () => {
  const events = load_fixture<{
    cancelRace: { beforeCancel: SimulationTaskEvent[] };
  }>("simulation-events.json");
  const idle: SimulationTaskSnapshot = {
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
  const running = events.cancelRace.beforeCancel[1].snapshot;

  // 1. Late start_simulation reply must not hide an in-flight cancel request.
  let resolveLateStart!: (snapshot: SimulationTaskSnapshot) => void;
  let resolveLateCancel!: (snapshot: SimulationTaskSnapshot) => void;
  const lateMock = create_mock_transport({
    get_simulation_state: () => idle,
    start_simulation: () =>
      new Promise<SimulationTaskSnapshot>((r) => {
        resolveLateStart = r;
      }),
    cancel_simulation: () =>
      new Promise<SimulationTaskSnapshot>((r) => {
        resolveLateCancel = r;
      }),
  });
  const lateCtrl = new TauriSimulationController(
    createTauriDesktopClient(lateMock.transport),
  );
  await lateCtrl.connect();
  const startPromise = lateCtrl.start(SAMPLE_REQUEST, 8);
  await Promise.resolve();
  lateMock.emit(SIMULATION_EVENT_NAME, {
    taskId: running.taskId!,
    seq: running.seq,
    snapshot: running,
  });
  const cancelPromise = lateCtrl.cancel();
  assert.equal(lateCtrl.get_snapshot().cancellingLocally, true);
  // Start reply arrives before cancel reply -> cancellingLocally must stay true!
  resolveLateStart(running);
  await startPromise;
  assert.equal(lateCtrl.get_snapshot().cancellingLocally, true);
  resolveLateCancel({
    ...running,
    seq: running.seq + 1,
    status: "cancelled",
  });
  await cancelPromise;
  assert.equal(lateCtrl.get_snapshot().cancellingLocally, false);
  assert.equal(lateCtrl.get_snapshot().snapshot.status, "cancelled");
  lateCtrl.disconnect();

  // 2. Reconnect read returning completed during pending cancel is buffered
  // and reconciled when cancel + fallback state read both reject.
  let hostState: SimulationTaskSnapshot = running;
  let failHostReads = false;
  let rejectCancel!: (reason: unknown) => void;
  const reconMock = create_mock_transport({
    get_simulation_state: () => {
      if (failHostReads) throw { code: "io", message: "fallback read failed" };
      return hostState;
    },
    cancel_simulation: () =>
      new Promise<SimulationTaskSnapshot>((_res, rej) => {
        rejectCancel = rej;
      }),
  });
  const reconCtrl = new TauriSimulationController(
    createTauriDesktopClient(reconMock.transport),
  );
  await reconCtrl.connect();
  const reconCancel = reconCtrl.cancel();
  // Host finishes while cancel is in-flight; reconnect observes completed snapshot.
  hostState = {
    ...running,
    seq: running.seq + 1,
    status: "completed",
    stage: null,
    completedRuns: running.totalRuns,
    totalResult: "1234",
    resultFilename: "done.gsr",
  };
  await reconCtrl.refresh_from_host();
  // Still frozen while cancel is pending.
  assert.equal(reconCtrl.get_snapshot().snapshot.status, "running");
  assert.equal(reconCtrl.get_snapshot().cancellingLocally, true);
  // Cancel rejects and fallback getSimulationState fails -> buffered completed reconciles!
  failHostReads = true;
  rejectCancel({ code: "conflict", message: "task already finished" });
  await reconCancel;
  assert.equal(reconCtrl.get_snapshot().cancellingLocally, false);
  assert.equal(reconCtrl.get_snapshot().snapshot.status, "completed");
  assert.equal(reconCtrl.get_snapshot().snapshot.resultFilename, "done.gsr");
  reconCtrl.disconnect();

  // 3. Two concurrent start() calls while listener subscription is still pending
  // must only invoke start_simulation once.
  let resolveListen!: (unlisten: () => void) => void;
  let startCount = 0;
  const raceTransport: TauriTransport = {
    async invoke<T>(command: DesktopCommand) {
      if (command === "get_simulation_state") return idle as T;
      if (command === "start_simulation") {
        startCount += 1;
        return running as T;
      }
      throw { code: "notImplemented", message: command };
    },
    listen() {
      return new Promise((r) => {
        resolveListen = r;
      });
    },
  };
  const raceCtrl = new TauriSimulationController(
    createTauriDesktopClient(raceTransport),
  );
  const first = raceCtrl.start(SAMPLE_REQUEST, 8);
  const second = raceCtrl.start(SAMPLE_REQUEST, 8);
  resolveListen(() => undefined);
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.equal(startCount, 1);
  raceCtrl.disconnect();
});

test("TauriResultSessionController confirms valid big-integer candidates and keeps active session on failure or stale confirm", async () => {
  const largeCandidate = load_fixture<ResultCandidateSession>(
    "result-candidate-large-total.json",
  );
  const secondCandidate: ResultCandidateSession = {
    ...largeCandidate,
    sessionId: "session-43",
    filename: "second.gsr",
  };
  const badCandidate: ResultCandidateSession = {
    ...largeCandidate,
    sessionId: "session-bad",
    analysis: {
      ...largeCandidate.analysis,
      totals: { ...largeCandidate.analysis.totals, result: "not-a-number" },
    },
  };

  let nextSelect: ResultCandidateSession | null = largeCandidate;
  let confirmResponse = {
    confirmed: true,
    activeSessionId: largeCandidate.sessionId as string | null,
  };
  let saveShouldFail = false;

  const mock = create_mock_transport({
    select_gsr_result: () => nextSelect,
    confirm_result_session: () => confirmResponse,
    save_result_fields: (args) => {
      if (saveShouldFail) {
        throw { code: "io", message: "sidecar locked" };
      }
      const req = (
        args as {
          request: {
            sessionId: string;
            fields: ResultCandidateSession["fields"];
          };
        }
      ).request;
      return {
        sessionId: req.sessionId,
        display: {
          ...displayConfigForMissingSidecar(req.fields.result_item_name),
          ...req.fields,
        },
      };
    },
    discard_result_draft: () => undefined,
  });
  const client = createTauriDesktopClient(mock.transport);
  const controller = new TauriResultSessionController(client);

  // 1. Open valid 9007199254740993 candidate -> confirmed.
  assert.equal(await controller.select_result(), true);
  assert.equal(controller.get_snapshot().result?.sessionId, "session-42");
  assert.equal(
    controller.get_snapshot().model?.total_result_text,
    "9007199254740993",
  );
  assert.equal(
    controller.get_snapshot().model?.total_result_display,
    "9007199254740993",
  );

  // 2. Dialog cancel preserves active session.
  nextSelect = null;
  assert.equal(await controller.select_result(), false);
  assert.equal(controller.get_snapshot().result?.sessionId, "session-42");

  // 3. Stale confirmation preserves active session.
  nextSelect = secondCandidate;
  confirmResponse = { confirmed: false, activeSessionId: "session-42" };
  assert.equal(await controller.select_result(), false);
  assert.equal(controller.get_snapshot().result?.sessionId, "session-42");

  // 4. Malformed Analysis candidate fails before confirming and preserves active session.
  const confirmsBefore = mock.calls.filter(
    (c) => c.command === "confirm_result_session",
  ).length;
  nextSelect = badCandidate;
  confirmResponse = { confirmed: true, activeSessionId: "session-bad" };
  assert.equal(await controller.select_result(), false);
  assert.equal(controller.get_snapshot().result?.sessionId, "session-42");
  assert.equal(
    mock.calls.filter((c) => c.command === "confirm_result_session").length,
    confirmsBefore,
  );

  // 5. Per-session save failure -> retry -> discard flow.
  saveShouldFail = true;
  controller.change_field("title", "新标题");
  await assert.rejects(() => controller.save(), /sidecar locked/);
  assert.equal(controller.get_snapshot().save_error, "sidecar locked");
  assert.equal(await controller.discard_failed_draft(), true);
  assert.equal(controller.get_snapshot().save_error, null);
  assert.equal(
    controller.get_snapshot().draft?.title,
    largeCandidate.fields.title,
  );
});

test("ResultSummaryPage displays full 9007199254740993 reading and Milestone 2 shell hides visualization/edit/export", async () => {
  const candidate = load_fixture<ResultCandidateSession>(
    "result-candidate-large-total.json",
  );
  const mock = create_mock_transport({
    select_gsr_result: () => candidate,
    confirm_result_session: () => ({
      confirmed: true,
      activeSessionId: candidate.sessionId,
    }),
    open_results_directory: () => undefined,
  });
  const client = createTauriDesktopClient(mock.transport);
  const controller = new TauriResultSessionController(client);
  assert.equal(await controller.select_result(), true);

  const summaryHtml = renderToStaticMarkup(
    createElement(ResultSummaryPage, {
      session: { ...controller.get_snapshot(), load_status: "未选择文件。" },
      on_select_result: controller.select_result,
      on_open_results_directory: () => client.openResultsDirectory(),
    }),
  );
  assert.match(summaryHtml, /9007199254740993/);
  assert.match(summaryHtml, /结果摘要/);
  assert.match(summaryHtml, /未选择文件。/);
  assert.doesNotMatch(summaryHtml, /导出素材|重播动画|图表预览|完成编辑/);

  const { TauriWorkbenchApp } = await import("./TauriWorkbenchApp");
  const shellHtml = renderToStaticMarkup(
    createElement(TauriWorkbenchApp, {
      client,
      initial_theme: "light",
    }),
  );
  assert.match(shellHtml, /运行模拟/);
  assert.match(shellHtml, /配置仓库/);
  assert.match(shellHtml, /结果摘要/);
  assert.match(shellHtml, /设置/);
  assert.match(shellHtml, /运行控制/);
  assert.doesNotMatch(shellHtml, /结果可视化|图表预览|导出素材|重播动画/);
});
