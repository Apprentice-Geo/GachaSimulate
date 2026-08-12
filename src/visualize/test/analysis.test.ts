import assert from "node:assert/strict";
import { test } from "node:test";
import { analysis_to_visualize, validate_analysis } from "../data/analysis";

const valid = {
  analysis_version: 2,
  result_item: { id: "draw_count", name: "抽数" },
  totals: { runs: "4", result: "11" },
  values: ["1", "2", "4"],
  cumulative: [0.25, 0.5, 1],
  statistic: {
    P5: "1",
    P25: "1",
    P50: "3",
    P75: "4",
    P95: "4",
    MIN: "1",
    MEAN: "2",
    MEAN_LEVEL: 0.5,
    MAX: "4",
  },
  termination_reason: [{ reason: "done", proportion: 100 }],
};

test("validates analysis and adapts it through VisualizeInput validation", () => {
  const result = analysis_to_visualize(valid, 1_700_000_000_123);
  assert.equal(result.total, 11);
  assert.deepEqual(result.result_item, { id: "draw_count", name: "抽数" });
  assert.equal(result.timestamp, 1_700_000_000);
  assert.deepEqual(result.values, [1, 2, 4]);
});

test("rejects unknown fields, non-canonical integers and unsupported values", () => {
  assert.throws(() => validate_analysis({ ...valid, extra: true }));
  assert.throws(() =>
    validate_analysis({ ...valid, totals: { ...valid.totals, runs: "01" } }),
  );
  assert.throws(() =>
    analysis_to_visualize({ ...valid, values: ["9007199254740992"] }, 0),
  );
  assert.throws(() => analysis_to_visualize({ ...valid, values: ["-1"] }, 0));
});

test("rejects the removed v1 metric contract", () => {
  assert.throws(() => validate_analysis({ ...valid, analysis_version: 1 }));
  assert.throws(() => validate_analysis({ ...valid, metric: "draw" }));
});
