import assert from "node:assert/strict";
import test from "node:test";
import {
  backend_qualifies,
  median,
  percentile,
  select_backend,
  type BackendAggregate,
  type SpikeThresholds,
} from "./electron_export_spike_metrics";

const thresholds: SpikeThresholds = {
  screenshot_total_ms: 20_000,
  ffmpeg_total_ms: 30_000,
  response_p95_ms: 100,
  response_max_ms: 250,
};

function result(
  backend: BackendAggregate["backend"],
  screenshot_total_ms: number[],
): BackendAggregate {
  return {
    backend,
    correct: true,
    screenshot_total_ms,
    ffmpeg_total_ms: [25_000],
    ui_probe_ms: [20, 30],
    main_loop_delay_ms: [5, 10],
  };
}

test("percentile and median use deterministic nearest-rank statistics", () => {
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(percentile([], 0.95), 0);
});

test("hard thresholds reject correctness, duration, and responsiveness failures", () => {
  assert.equal(
    backend_qualifies(result("capture-page", [19_000]), thresholds),
    true,
  );
  assert.equal(
    backend_qualifies(result("capture-page", [20_001]), thresholds),
    false,
  );
  const incorrect = result("capture-page", [10_000]);
  incorrect.correct = false;
  assert.equal(backend_qualifies(incorrect, thresholds), false);
  const unresponsive = result("capture-page", [10_000]);
  unresponsive.ui_probe_ms = [251];
  assert.equal(backend_qualifies(unresponsive, thresholds), false);
});

test("selection requires a qualifying backend and applies the 10% rule", () => {
  assert.equal(
    select_backend(
      [result("capture-page", [10_000]), result("cdp", [8_000])],
      thresholds,
    ).backend,
    "cdp",
  );
  const failed = result("cdp", [30_000]);
  assert.equal(
    select_backend([result("capture-page", [10_000]), failed], thresholds)
      .backend,
    "capture-page",
  );
  assert.equal(select_backend([failed], thresholds).backend, null);
});

test("equivalent qualifying backends prefer capturePage", () => {
  assert.equal(
    select_backend(
      [result("capture-page", [10_000]), result("cdp", [9_500])],
      thresholds,
    ).backend,
    "capture-page",
  );
});
