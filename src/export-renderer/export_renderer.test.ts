import assert from "node:assert/strict";
import test from "node:test";
import { EXPORT_RENDERER_CHANNELS } from "../shared/export_renderer";
import { ExportRendererCoordinator } from "./coordinator";
import { wait_for_export_layout } from "./layout";
import { create_export_renderer_api } from "./preload_bridge";
import type { CDFViewModel } from "../visualize/types/cdf";

class FakeIpcRenderer {
  readonly listeners = new Map<
    string,
    Set<(event: unknown, value: unknown) => void>
  >();
  readonly sent: Array<{ channel: string; value: unknown }> = [];

  on(channel: string, listener: (event: unknown, value: unknown) => void) {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  }

  removeListener(
    channel: string,
    listener: (event: unknown, value: unknown) => void,
  ) {
    this.listeners.get(channel)?.delete(listener);
  }

  send(channel: string, value: unknown) {
    this.sent.push({ channel, value });
  }

  emit(channel: string, value: unknown) {
    for (const listener of this.listeners.get(channel) ?? []) {
      listener({}, value);
    }
  }
}

const view_model: CDFViewModel = {
  title: "Export test",
  target: "one result",
  result_item: { id: "result", name: "Result" },
  total_result: 1,
  total_result_display: "1 result",
  runs: 1,
  result_item_unit: "result",
  axis_title: "Result count",
  subtitle: "",
  note: "",
  chart_points: [{ draw: 1, cumulative: 1 }],
  termination_reason: [{ reason: "done", proportion: 100 }],
  x_domain_max: 1,
  metrics: [
    {
      key: "P50",
      label: "P50",
      value: 1,
      display_value: "1 result",
      color: "#fff",
    },
  ],
  markers: [
    {
      key: "P50",
      label: "P50",
      draw: 1,
      level: 1,
      color: "#fff",
      weight: "primary",
    },
  ],
};

const initialize_message = {
  job_id: "job-1",
  view_model,
};

test("preload bridge forwards only valid inbound messages and honors listener cleanup", () => {
  const ipc = new FakeIpcRenderer();
  const api = create_export_renderer_api(ipc);
  const received: unknown[] = [];
  const remove = api.onRenderFrame((message) => received.push(message));

  ipc.emit(EXPORT_RENDERER_CHANNELS.render_frame, {
    job_id: "job-1",
    frame: 0,
  });
  ipc.emit(EXPORT_RENDERER_CHANNELS.render_frame, {
    job_id: "job-1",
    frame: 60,
  });
  ipc.emit(EXPORT_RENDERER_CHANNELS.render_frame, {
    job_id: "",
    frame: 1,
  });
  remove();
  ipc.emit(EXPORT_RENDERER_CHANNELS.render_frame, {
    job_id: "job-1",
    frame: 1,
  });

  assert.deepEqual(received, [{ job_id: "job-1", frame: 0 }]);
});

test("preload bridge buffers initialization sent before React subscribes", () => {
  const ipc = new FakeIpcRenderer();
  const api = create_export_renderer_api(ipc);
  ipc.emit(EXPORT_RENDERER_CHANNELS.initialize, initialize_message);

  const received: unknown[] = [];
  api.onInitialize((message) => received.push(message));

  assert.deepEqual(received, [initialize_message]);
});

test("preload bridge validates every outbound message", () => {
  const ipc = new FakeIpcRenderer();
  const api = create_export_renderer_api(ipc);

  api.initialized({ job_id: "job-1" });
  api.frameReady({ job_id: "job-1", frame: 59 });
  api.rendererFailed({ job_id: "job-1", message: "render failed" });
  assert.throws(() => api.frameReady({ job_id: "job-1", frame: 60 }));
  assert.throws(() => api.rendererFailed({ job_id: "", message: "bad" }));

  assert.deepEqual(
    ipc.sent.map(({ channel }) => channel),
    [
      EXPORT_RENDERER_CHANNELS.initialized,
      EXPORT_RENDERER_CHANNELS.frame_ready,
      EXPORT_RENDERER_CHANNELS.renderer_failed,
    ],
  );
});

test("preload bridge rejects malformed nested initialize view models", () => {
  const ipc = new FakeIpcRenderer();
  const api = create_export_renderer_api(ipc);
  const received: unknown[] = [];
  api.onInitialize((message) => received.push(message));

  ipc.emit(EXPORT_RENDERER_CHANNELS.initialize, initialize_message);
  ipc.emit(EXPORT_RENDERER_CHANNELS.initialize, {
    job_id: "job-2",
    view_model: { ...view_model, chart_points: [{ draw: "1", cumulative: 1 }] },
  });

  assert.deepEqual(received, [initialize_message]);
});

test("coordinator enforces initialization and exact job/frame sequencing", () => {
  const coordinator = new ExportRendererCoordinator();
  const early_frame = coordinator.acceptFrame({ job_id: "job-1", frame: 0 });
  assert.equal(early_frame.ok, false);

  const next = new ExportRendererCoordinator();
  assert.equal(next.acceptInitialize(initialize_message).ok, true);
  assert.equal(next.completeInitialization("other-job"), false);
  assert.equal(next.completeInitialization("job-1"), true);

  const wrong_job = next.acceptFrame({ job_id: "other-job", frame: 0 });
  assert.equal(wrong_job.ok, false);
  if (!wrong_job.ok) assert.equal(wrong_job.failure.job_id, "job-1");

  const invalid_frame = new ExportRendererCoordinator();
  assert.equal(invalid_frame.acceptInitialize(initialize_message).ok, true);
  assert.equal(invalid_frame.completeInitialization("job-1"), true);
  assert.equal(
    invalid_frame.acceptFrame({ job_id: "job-1", frame: 60 }).ok,
    false,
  );
});

test("frame completion is idempotent under StrictMode effect replay", () => {
  const coordinator = new ExportRendererCoordinator();
  assert.equal(coordinator.acceptInitialize(initialize_message).ok, true);
  assert.equal(coordinator.completeInitialization("job-1"), true);
  assert.equal(coordinator.completeInitialization("job-1"), false);

  const result = coordinator.acceptFrame({ job_id: "job-1", frame: 57 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(coordinator.completeFrame(result.token), true);
  assert.equal(coordinator.completeFrame(result.token), false);
  assert.equal(
    coordinator.acceptFrame({ job_id: "job-1", frame: 57 }).ok,
    false,
  );
});

test("initial layout waits for fonts and one animation frame", async () => {
  const order: string[] = [];
  let resolve_fonts: (() => void) | undefined;
  const fonts_ready = new Promise<void>((resolve) => {
    resolve_fonts = () => {
      order.push("fonts");
      resolve();
    };
  });
  const waiting = wait_for_export_layout(
    {
      fonts: { ready: fonts_ready },
      querySelector: () => ({
        getBoundingClientRect: () => ({ width: 3840, height: 2160 }),
      }),
    },
    async () => {
      order.push("raf");
    },
  );
  resolve_fonts?.();
  await waiting;
  assert.deepEqual(order, ["fonts", "raf"]);
});

test("initial layout reports font and canvas failures", async () => {
  await assert.rejects(() =>
    wait_for_export_layout(
      {
        fonts: { ready: Promise.reject(new Error("font load failed")) },
        querySelector: () => null,
      },
      async () => undefined,
    ),
  );
  await assert.rejects(
    () =>
      wait_for_export_layout(
        {
          fonts: { ready: Promise.resolve() },
          querySelector: () => ({
            getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
          }),
        },
        async () => undefined,
      ),
    /must be 3840x2160/,
  );
});
