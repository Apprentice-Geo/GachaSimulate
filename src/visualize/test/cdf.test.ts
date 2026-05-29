import assert from "node:assert/strict";
import test from "node:test";
import { normalize_input } from "../data/normalize_input";
import { get_cdf_level_at_draw } from "../data/cdf";
import { MARKER_VISUALS } from "../components/cdf_marker_visuals";
import { CDF_MARKER_VIEW_CONFIG } from "../view/cdf_view_config";
import { build_visualize_view_model } from "../view/cdf_view_model";
import {
  build_curve_path,
  build_marker_views,
} from "../view/cdf_overlay_layout";
import {
  DISTRIBUTION_STATISTIC_GROUPS,
  STATISTIC_VIEW_CONFIG,
  STATISTIC_VIEW_ORDER,
  TERMINATION_REASON_VIEW_CONFIG,
} from "../view/statistic_view_config";
import type { CDFMarker } from "../types/visualize_input";
import type { VisualizeInput } from "../types/visualize_input";

test("get_cdf_level_at_draw returns stepwise cumulative levels", () => {
  const sparse_points = [
    { draw: 1, cumulative: 0.2 },
    { draw: 100, cumulative: 0.8 },
  ];

  assert.equal(get_cdf_level_at_draw(sparse_points, 1), 0.2);
  assert.equal(get_cdf_level_at_draw(sparse_points, 50), 0.2);
  assert.equal(get_cdf_level_at_draw(sparse_points, 100), 0.8);
  assert.equal(get_cdf_level_at_draw(sparse_points, 101), 0.8);
});

test("statistic view config exposes expected ordering", () => {
  assert.equal(
    CDF_MARKER_VIEW_CONFIG.MEAN.color,
    "var(--color-cdf-marker-mean)",
  );
  assert.equal(CDF_MARKER_VIEW_CONFIG.P50.weight, "primary");
  assert.deepEqual(STATISTIC_VIEW_ORDER, [
    "P5",
    "P25",
    "P50",
    "P75",
    "P95",
    "MEAN",
    "MIN",
    "MAX",
  ]);
  assert.equal(STATISTIC_VIEW_CONFIG.P50.description, "50% 模拟在此抽数内达成");
  assert.deepEqual(DISTRIBUTION_STATISTIC_GROUPS[1].keys, ["P50", "MEAN"]);
  assert.deepEqual(TERMINATION_REASON_VIEW_CONFIG.segment_colors, [
    "var(--color-pk-a)",
    "var(--color-pk-b)",
  ]);
});

test("marker visuals rank primary above faint", () => {
  assert.ok(MARKER_VISUALS.primary.opacity > MARKER_VISUALS.faint.opacity);
  assert.ok(
    MARKER_VISUALS.primary.stroke_width > MARKER_VISUALS.faint.stroke_width,
  );
  assert.ok(
    MARKER_VISUALS.primary.point_radius > MARKER_VISUALS.faint.point_radius,
  );
  assert.ok(
    MARKER_VISUALS.primary.label_font_size >
      MARKER_VISUALS.faint.label_font_size,
  );
});

test("build_marker_views positions labels for p50 and mean", () => {
  const test_markers: CDFMarker[] = [
    {
      key: "P50",
      label: "P50",
      draw: 40,
      level: 0.48,
      color: "red",
      weight: "primary",
    },
    {
      key: "MEAN",
      label: "MEAN",
      draw: 35,
      level: 0.62,
      color: "purple",
      weight: "strong",
    },
  ];
  const plot_area = { x: 10, y: 20, width: 200, height: 100 };
  const x_scale = (draw: unknown) => Number(draw) * 2;
  const y_scale = (level: unknown) => 120 - Number(level) * 100;

  const marker_views = build_marker_views(
    test_markers,
    plot_area,
    x_scale,
    y_scale,
  );
  const p50_view = marker_views.find((view) => view.marker.key === "P50");
  const mean_view = marker_views.find((view) => view.marker.key === "MEAN");

  assert.equal(marker_views.length, 2);
  assert.ok(p50_view);
  assert.ok(mean_view);
  assert.equal(p50_view.y, 70);
  assert.equal(mean_view.y, 58);
  assert.equal(p50_view.text_anchor, "end");
  assert.equal(mean_view.text_anchor, "end");
  assert.equal(p50_view.dominant_baseline, "text-after-edge");
  assert.equal(mean_view.dominant_baseline, "hanging");
});

test("build_curve_path clamps cumulative values", () => {
  const x_scale = (draw: unknown) => Number(draw) * 2;
  const y_scale = (level: unknown) => 120 - Number(level) * 100;

  assert.equal(
    build_curve_path(
      [
        { draw: 1, cumulative: 0.2 },
        { draw: 3, cumulative: 1.2 },
      ],
      x_scale,
      y_scale,
    ),
    "M 2.00 100.00 L 6.00 100.00 L 6.00 20.00",
  );
});

test("build_visualize_view_model derives metrics cost and marker weights", () => {
  const input: VisualizeInput = {
    title: "核心模拟结果",
    target: "target",
    draw_counts: 100,
    note: "",
    timestamp: 0,
    draws: [1, 2],
    cumulative: [0.5, 1],
    statistic: {
      P5: 1,
      P25: 1,
      P50: 1,
      P75: 2,
      P95: 2,
      MIN: 1,
      MEAN_LEVEL: 0.75,
      MEAN: 1.5,
      MAX: 2,
      COST: 6,
    },
    termination_reason: [{ reason: "success", proportion: 100 }],
  };

  const normalized_input = normalize_input(input);
  assert.equal("metrics" in normalized_input, false);
  assert.equal("markers" in normalized_input, false);

  const view_model = build_visualize_view_model(normalized_input);
  assert.deepEqual(
    view_model.metrics.map((metric) => metric.key),
    STATISTIC_VIEW_ORDER,
  );
  assert.equal(view_model.cost.display_value, "6");
  assert.equal(view_model.cost.unit, "RMB");
  assert.equal(
    view_model.markers.find((marker) => marker.key === "P50")?.weight,
    "primary",
  );
});
