import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { displayConfigForMissingSidecar } from "../../shared/tauri_desktop_contract";
import {
  apply_curve_display,
  build_curve_view_model,
  compute_x_domain_max,
  draw_to_plot_ratio,
  get_cdf_level_at_exact_draw,
  parse_u64_bigint,
  prepare_curve_data,
} from "../data/curve_model";
import type { Analysis } from "../types/analysis";

const LARGE_TOTAL_CANDIDATE_PATH = resolve(
  __dirname,
  "../../../crates/gachasimulate-desktop-contract/fixtures/result-candidate-large-total.json",
);

function load_large_total_analysis(): Analysis {
  const candidate = JSON.parse(
    readFileSync(LARGE_TOTAL_CANDIDATE_PATH, "utf8"),
  ) as { analysis: Analysis };
  return candidate.analysis;
}

test("prepare_curve_data and apply_curve_display preserve exact 9007199254740993 total", () => {
  const analysis = load_large_total_analysis();
  const display = {
    ...displayConfigForMissingSidecar(analysis.result_item.name),
    result_item_unit: "积分",
  };
  const prepared = prepare_curve_data(analysis);
  assert.equal(prepared.total_result, 9007199254740993n);
  assert.equal(prepared.total_result_text, "9007199254740993");
  assert.equal(prepared.runs, BigInt(analysis.totals.runs));
  assert.equal(prepared.runs_text, analysis.totals.runs);

  const model = apply_curve_display(prepared, display);
  assert.equal(model.total_result, 9007199254740993n);
  assert.equal(model.total_result_text, "9007199254740993");
  assert.equal(model.total_result_display, "9007199254740993 积分");
  assert.equal(model.result_item.id, analysis.result_item.id);
  assert.equal(model.result_item.name, analysis.result_item.name);

  for (const point of model.chart_points) {
    assert.ok(Number.isFinite(point.x_ratio));
    assert.ok(point.x_ratio >= 0 && point.x_ratio <= 1);
  }
  for (const marker of model.markers) {
    assert.ok(Number.isFinite(marker.x_ratio));
    assert.ok(marker.x_ratio >= 0 && marker.x_ratio <= 1);
    assert.equal(marker.draw_text, analysis.statistic[marker.key]);
  }
});

test("curve model handles u64::MAX values with exact BigInt readings and finite plot ratios", () => {
  const u64Max = "18446744073709551615";
  const halfMax = "9223372036854775807";
  const analysis: Analysis = {
    result_item: { id: "score", name: "积分" },
    totals: { runs: "2", result: u64Max },
    values: [halfMax, u64Max],
    cumulative: [0.5, 1],
    statistic: {
      P5: halfMax,
      P25: halfMax,
      P50: halfMax,
      P75: u64Max,
      P95: u64Max,
      MIN: halfMax,
      MEAN: "13835058055282163711",
      MEAN_LEVEL: 0.5,
      MAX: u64Max,
    },
    termination_reason: [{ reason: "done", proportion: 100 }],
  };
  const model = build_curve_view_model(
    analysis,
    displayConfigForMissingSidecar("积分"),
  );
  assert.equal(model.total_result, 18446744073709551615n);
  assert.equal(model.total_result_display, u64Max);
  assert.equal(
    model.metrics.find((m) => m.key === "MAX")?.display_value,
    u64Max,
  );
  assert.equal(
    model.metrics.find((m) => m.key === "MEAN")?.display_value,
    "13835058055282163711",
  );
  assert.ok(model.x_domain_max > 18446744073709551615n);
  assert.ok(
    model.chart_points[0].x_ratio > 0.45 &&
      model.chart_points[0].x_ratio < 0.52,
  );
  assert.ok(
    model.chart_points[1].x_ratio > 0.95 &&
      model.chart_points[1].x_ratio < 0.97,
  );
  assert.equal(
    get_cdf_level_at_exact_draw(model.chart_points, 9223372036854775807n),
    0.5,
  );
  assert.equal(
    get_cdf_level_at_exact_draw(model.chart_points, 9223372036854775808n),
    0.5,
  );
  assert.equal(
    get_cdf_level_at_exact_draw(model.chart_points, 18446744073709551615n),
    1,
  );
});

test("curve model rejects u64 overflows, zero runs, and non-canonical integers", () => {
  assert.equal(compute_x_domain_max(0n), 1n);
  assert.equal(draw_to_plot_ratio(0n, 10n), 0);
  assert.equal(draw_to_plot_ratio(10n, 10n), 1);
  assert.throws(() => parse_u64_bigint("18446744073709551616", "test"));
  assert.throws(() => parse_u64_bigint("-1", "test"));
  assert.throws(() => parse_u64_bigint("01", "test"));

  const analysis = load_large_total_analysis();
  assert.throws(() =>
    prepare_curve_data({
      ...analysis,
      totals: { ...analysis.totals, result: "18446744073709551616" },
    }),
  );
  assert.throws(() =>
    prepare_curve_data({
      ...analysis,
      totals: { ...analysis.totals, runs: "0" },
    }),
  );
});
