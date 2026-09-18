import assert from "node:assert/strict";
import test from "node:test";
import { validate_analysis } from "../data/analysis";
import { validate_display_config } from "../data/validate_display_config";
import analysis_fixture from "../fixtures/example_analysis.json";
import display_fixture from "../fixtures/example_display.json";

const valid = {
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

test("validates Analysis without display metadata", () => {
  assert.deepEqual(validate_analysis(valid), valid);
  assert.throws(() => validate_analysis({ ...valid, unexpected: true }));
  assert.throws(() => validate_analysis({ ...valid, values: ["2", "1"] }));
});

test("shared fixtures satisfy Analysis and DisplayConfig contracts", () => {
  assert.deepEqual(validate_analysis(analysis_fixture), analysis_fixture);
  assert.deepEqual(validate_display_config(display_fixture), display_fixture);
});

test("DisplayConfig v2 rejects v1, legacy fields, and mixed fields", () => {
  assert.throws(() =>
    validate_display_config({ ...display_fixture, display_version: 1 }),
  );
  assert.throws(() =>
    validate_display_config({
      display_version: 2,
      title: display_fixture.title,
      target: display_fixture.target,
      result_item_name: display_fixture.result_item_name,
      note: display_fixture.note,
      price: "旧副标题",
      unit: "旧单位",
    }),
  );
  assert.throws(() =>
    validate_display_config({
      ...display_fixture,
      price: "旧副标题",
      unit: "旧单位",
    }),
  );
});
