import assert from "node:assert/strict";
import test from "node:test";
import { validate_analysis } from "../data/analysis";

const valid = {
  analysis_version: 2,
  result_item: { id: "draw_count", name: "抽数" },
  totals: { runs: "2", result: "3" },
  values: ["1", "2"],
  cumulative: [0.5, 1],
  statistic: {
    P5: "1",
    P25: "1",
    P50: "1",
    P75: "2",
    P95: "2",
    MIN: "1",
    MEAN: "1",
    MEAN_LEVEL: 0.5,
    MAX: "2",
  },
  termination_reason: [{ reason: "done", proportion: 100 }],
};

test("validates AnalysisV2 without display metadata", () => {
  assert.deepEqual(validate_analysis(valid), valid);
  assert.throws(() => validate_analysis({ ...valid, analysis_version: 1 }));
  assert.throws(() => validate_analysis({ ...valid, values: ["2", "1"] }));
});
