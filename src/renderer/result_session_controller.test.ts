import assert from "node:assert/strict";
import test from "node:test";
import type {
  ResultEditorState,
  SavedResultFields,
  SaveResultFieldsRequest,
} from "../shared/result_editor";
import { result_fixture } from "../dev/ui_fixtures";
import { ResultSessionController } from "./result_session_controller";
import {
  ExportWorkflowController,
  type ExportWorkflowApi,
} from "./export_workflow_controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((done) => setImmediate(done));
function fixture(id: string): ResultEditorState {
  const result = structuredClone(result_fixture());
  result.session_id = id;
  result.fields.title = result.display.title = id;
  return result;
}

function setup() {
  const selections: Array<
    ReturnType<typeof deferred<ResultEditorState | null>>
  > = [];
  const saves: Array<{
    request: SaveResultFieldsRequest;
    response: ReturnType<typeof deferred<SavedResultFields>>;
  }> = [];
  const controller = new ResultSessionController({
    selectGsrResult: () => {
      const request = deferred<ResultEditorState | null>();
      selections.push(request);
      return request.promise;
    },
    saveResultFields: (request) => {
      const response = deferred<SavedResultFields>();
      saves.push({ request, response });
      return response.promise;
    },
  });
  const open = async (id: string) => {
    const operation = controller.select_result();
    await tick();
    selections.at(-1)!.resolve(fixture(id));
    assert.equal(await operation, true);
  };
  const saved = (index: number) => {
    const { request, response } = saves[index];
    response.resolve({
      session_id: request.session_id,
      display: { display_version: 2, ...request.fields },
    });
  };
  return { controller, selections, saves, open, saved };
}

test("a previous session save cannot replace a new session or its busy state", async () => {
  const w = setup();
  await w.open("A");
  w.controller.change_field("title", "saved A");
  const saving = w.controller.save();
  await tick();
  await w.open("B");
  w.controller.change_field("title", "draft B");
  const loading = w.controller.select_result();
  await tick();
  w.saved(0);
  await saving;
  assert.equal(w.controller.get_snapshot().result?.session_id, "B");
  assert.equal(w.controller.get_snapshot().draft?.title, "draft B");
  assert.equal(w.controller.get_snapshot().loading, true);
  w.selections.at(-1)!.resolve(fixture("C"));
  await loading;
  assert.equal(w.controller.get_snapshot().result?.session_id, "C");
});

test("a returning page retains newer draft while an old save confirms only saved fields", async () => {
  const w = setup();
  await w.open("A");
  const original = w.controller.get_snapshot();
  const unsubscribe = w.controller.subscribe(() => undefined);
  w.controller.change_field("title", "first draft");
  const saving = w.controller.save();
  await tick();
  unsubscribe();
  w.controller.change_field("title", "new draft");
  const unsubscribe_next = w.controller.subscribe(() => undefined);
  w.saved(0);
  await saving;
  const current = w.controller.get_snapshot();
  assert.equal(current.draft?.title, "new draft");
  assert.equal(current.preview?.title, "new draft");
  assert.equal(current.model?.title, "first draft");
  assert.equal(current.result?.analysis, original.result?.analysis);
  assert.equal(current.preview?.chart_points, original.model?.chart_points);
  assert.equal(current.preview?.markers, original.model?.markers);
  unsubscribe_next();
});

test("save failure survives subscriptions and preserves draft for an explicit retry", async () => {
  const w = setup();
  await w.open("A");
  w.controller.change_field("title", "unsaved");
  const saving = w.controller.save();
  const rejected = assert.rejects(saving, /disk unavailable/);
  await tick();
  w.saves[0].response.reject(new Error("disk unavailable"));
  await rejected;
  w.controller.subscribe(() => undefined)();
  assert.equal(w.controller.get_snapshot().draft?.title, "unsaved");
  assert.match(w.controller.get_snapshot().save_error!, /disk unavailable/);
  await assert.rejects(w.controller.wait_for_saves("A"), /disk unavailable/);
  assert.equal(w.saves.length, 1);
  const retry = w.controller.save();
  await tick();
  w.saved(1);
  await retry;
  assert.equal(w.controller.get_snapshot().save_error, null);
  assert.equal(w.controller.get_snapshot().model?.title, "unsaved");
});

test("loading is shared and deduplicated and a failed model retains the valid session", async () => {
  const w = setup();
  await w.open("A");
  const operation = w.controller.select_result();
  assert.equal(w.controller.select_result(), operation);
  await tick();
  const invalid = fixture("invalid");
  invalid.analysis.totals.result = "9007199254740992";
  w.selections.at(-1)!.resolve(invalid);
  assert.equal(await operation, false);
  assert.equal(w.controller.get_snapshot().result?.session_id, "A");
  assert.match(w.controller.get_snapshot().load_error!, /visualization range/);
  const cancelled = w.controller.select_result();
  await tick();
  w.selections.at(-1)!.resolve(null);
  assert.equal(await cancelled, false);
  assert.equal(w.controller.get_snapshot().load_error, null);
  assert.ok(w.controller.get_snapshot().load_status);
  assert.equal(w.controller.get_snapshot().result?.session_id, "A");
  await w.open("B");
  assert.equal(w.controller.get_snapshot().load_error, null);
});

test("unit and text editing reuse numerical data and switching sessions prepares new data", async () => {
  const w = setup();
  await w.open("A");
  const original = w.controller.get_snapshot().model!;
  w.controller.change_field("result_item_unit", "代币");
  const preview = w.controller.get_snapshot().preview!;
  assert.equal(preview.chart_points, original.chart_points);
  assert.equal(preview.markers, original.markers);
  assert.equal(preview.x_domain_max, original.x_domain_max);
  assert.match(preview.total_result_display, /代币/);
  await w.open("B");
  assert.notEqual(
    w.controller.get_snapshot().model!.chart_points,
    original.chart_points,
  );
});

test("export barrier follows serialized saves including a newly extended queue tail", async () => {
  const w = setup();
  await w.open("A");
  w.controller.change_field("title", "one");
  const one = w.controller.save();
  w.controller.change_field("title", "two");
  const two = w.controller.save();
  let prepared = false;
  const barrier = w.controller.wait_for_saves("A").then(() => {
    prepared = true;
  });
  await tick();
  assert.equal(w.saves.length, 1);
  w.saved(0);
  await one;
  await tick();
  assert.equal(w.saves.length, 2);
  assert.equal(prepared, false);
  w.controller.change_field("title", "three");
  const three = w.controller.save();
  w.saved(1);
  await two;
  await tick();
  assert.equal(w.saves.length, 3);
  assert.equal(prepared, false);
  w.saved(2);
  await three;
  await barrier;
  assert.equal(w.controller.get_snapshot().model?.title, "three");
});

function exporting(controller: ResultSessionController) {
  let preparations = 0;
  const api: ExportWorkflowApi = {
    prepareExport: async () => {
      preparations += 1;
      return { reservation_id: "reservation" };
    },
    selectExportDestination: async () => {
      throw new Error("unexpected destination selection");
    },
    confirmExportOverwrite: async () => {
      throw new Error("unexpected overwrite");
    },
    cancelExport: async () => undefined,
    retryExportCleanup: async () => undefined,
    openExportDirectory: async () => undefined,
    exitAfterExportCleanup: async () => undefined,
    onExportEvent: () => () => undefined,
  };
  const workflow = new ExportWorkflowController(api, controller.wait_for_saves);
  const context = { session_id: "A", default_base_name: "a" };
  workflow.open(context);
  const operation = workflow.start_preparation(context);
  return { workflow, operation, preparations: () => preparations };
}

test("failed save and changed session both prevent a main export reservation", async () => {
  for (const outcome of ["failed", "changed"] as const) {
    const w = setup();
    await w.open("A");
    w.controller.change_field("title", "pending");
    const e = exporting(w.controller);
    await tick();
    if (outcome === "changed") {
      await w.open("B");
      w.saved(0);
    } else w.saves[0].response.reject(new Error("cannot save"));
    await e.operation;
    assert.equal(e.preparations(), 0);
    assert.equal(e.workflow.get_snapshot().flow.phase, "closed");
    assert.equal(e.workflow.get_snapshot().notice?.kind, "error");
  }
});

test("cancellation during renderer save barrier never sends a late reservation", async () => {
  const w = setup();
  await w.open("A");
  w.controller.change_field("title", "pending");
  const e = exporting(w.controller);
  await tick();
  e.workflow.cancel_or_return();
  w.saved(0);
  await e.operation;
  assert.equal(e.preparations(), 0);
  assert.equal(e.workflow.get_snapshot().flow.phase, "closed");
  assert.equal(e.workflow.get_snapshot().notice?.kind, "cancelled");
});

test("export waits for an explicit retry already pending after a save failure", async () => {
  const w = setup();
  await w.open("A");
  w.controller.change_field("title", "retry");
  const initial = w.controller.save();
  const rejected = assert.rejects(initial, /blocked/);
  await tick();
  w.saves[0].response.reject(new Error("blocked"));
  await rejected;
  const retry = w.controller.save();
  await tick();
  const e = exporting(w.controller);
  await tick();
  assert.equal(e.preparations(), 0);
  w.saved(1);
  await retry;
  await e.operation;
  assert.equal(e.preparations(), 1);
  assert.equal(w.controller.get_snapshot().save_error, null);
});
