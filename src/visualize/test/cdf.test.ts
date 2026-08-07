import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import schema from "../../../docs/schemas/visualize_input.schema.json";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../constants";
import { normalize_input } from "../data/normalize_input";
import { load_input_from_text } from "../data/load_input";
import { get_cdf_level_at_draw } from "../data/cdf";
import { validate_input } from "../data/validate_input";
import example_input from "../fixtures/example_input.json";
import { build_visualize_view_model } from "../view/cdf_view_model";
import {
  build_curve_path,
  build_marker_views,
  resolve_marker_label_collisions,
} from "../view/cdf_overlay_layout";
import { STATISTIC_VIEW_ORDER } from "../view/statistic_view_config";
import {
  build_animation_progress,
  segment_progress,
} from "../animation/progress";
import { ANIMATION_TIMELINE, ANIMATION_TOTAL_MS } from "../animation/timeline";
import type { MarkerView } from "../view/cdf_overlay_layout";
import type { CDFMarker, VisualizeInput } from "../types/visualize_input";
import {
  VISUALIZE_INPUT_REQUIRED_KEYS,
  VISUALIZE_STATISTIC_REQUIRED_KEYS,
} from "../types/visualize_input";

type VisualizeInputSchema = {
  required: string[];
  properties: {
    statistic: {
      required: string[];
    };
  };
};

function make_valid_input(
  overrides: Partial<VisualizeInput> = {},
): VisualizeInput {
  const base_input: VisualizeInput = {
    title: "核心模拟结果",
    target: "target",
    metric: "draw",
    total: 3,
    note: "",
    timestamp: 0,
    values: [1, 2, 3],
    cumulative: [0.25, 0.75, 1],
    price: "",
    unit: "",
    statistic: {
      P5: 1,
      P25: 1,
      P50: 2,
      P75: 2,
      P95: 3,
      MIN: 1,
      MEAN_LEVEL: 0.75,
      MEAN: 2,
      MAX: 3,
    },
    termination_reason: [{ reason: "success", proportion: 100 }],
  };

  return {
    ...base_input,
    ...overrides,
    statistic: {
      ...base_input.statistic,
      ...overrides.statistic,
    },
  };
}

function read_css_px_token(css: string, token_name: string): number {
  const match = new RegExp(`--${token_name}:\\s*(\\d+)px`).exec(css);
  assert.ok(match, `Missing CSS token --${token_name}`);
  return Number(match[1]);
}

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

test("canvas constants stay aligned with CSS tokens", () => {
  const tokens_css = readFileSync(
    path.join(process.cwd(), "src/visualize/styles/tokens.css"),
    "utf-8",
  );

  assert.equal(read_css_px_token(tokens_css, "canvas-width"), CANVAS_WIDTH);
  assert.equal(read_css_px_token(tokens_css, "canvas-height"), CANVAS_HEIGHT);
});

test("top header expansion preserves main region start", () => {
  const tokens_css = readFileSync(
    path.join(process.cwd(), "src/visualize/styles/tokens.css"),
    "utf-8",
  );

  assert.equal(
    read_css_px_token(tokens_css, "page-top-margin") +
      read_css_px_token(tokens_css, "top-height"),
    320,
  );
});

test("schema required fields stay aligned with TS contract keys", () => {
  const visualize_schema = schema as VisualizeInputSchema;

  assert.deepEqual(
    [...visualize_schema.required].sort(),
    [...VISUALIZE_INPUT_REQUIRED_KEYS].sort(),
  );
  assert.deepEqual(
    [...visualize_schema.properties.statistic.required].sort(),
    [...VISUALIZE_STATISTIC_REQUIRED_KEYS].sort(),
  );
});

test("fixture visualize input satisfies schema and business rules", () => {
  const result = validate_input(example_input);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("selected file text passes through JSON, schema, and normalization", async () => {
  const normalized = await load_input_from_text(
    JSON.stringify(make_valid_input()),
  );
  assert.equal(normalized.metric_label, "抽数");
  assert.equal(normalized.total_display, "3 抽");

  await assert.rejects(load_input_from_text("not json"), SyntaxError);
  await assert.rejects(load_input_from_text('{"title":"missing fields"}'));
});

test("validate_input enforces termination reason contract", () => {
  assert.equal(validate_input(make_valid_input()).valid, true);
  assert.equal(
    validate_input(
      make_valid_input({
        termination_reason: [
          { reason: "success", proportion: 70 },
          { reason: "exchange", proportion: 30 },
        ],
      }),
    ).valid,
    true,
  );

  const many_reasons = validate_input(
    make_valid_input({
      termination_reason: [
        { reason: "success", proportion: 40 },
        { reason: "exchange", proportion: 30 },
        { reason: "other", proportion: 30 },
      ],
    }),
  );
  assert.equal(many_reasons.valid, true);

  const invalid_total = validate_input(
    make_valid_input({
      termination_reason: [
        { reason: "success", proportion: 60 },
        { reason: "exchange", proportion: 30 },
      ],
    }),
  );
  assert.equal(invalid_total.valid, false);
  assert.match(invalid_total.errors.join("\n"), /合计必须为 100/);
});

test("validate_input rejects the old draw-specific contract", () => {
  const old_input = {
    title: "旧输入",
    target: "target",
    draw_counts: 3,
    note: "",
    timestamp: 0,
    draws: [1, 2, 3],
    cumulative: [0.25, 0.75, 1],
    statistic: {
      P5: 1,
      P25: 1,
      P50: 2,
      P75: 2,
      P95: 3,
      MIN: 1,
      MEAN_LEVEL: 0.75,
      MEAN: 2,
      MAX: 3,
      COST: 0,
    },
    termination_reason: [{ reason: "success", proportion: 100 }],
  };

  assert.equal(validate_input(old_input).valid, false);
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

test("resolve_marker_label_collisions returns adjusted copies", () => {
  const marker: CDFMarker = {
    key: "P50",
    label: "P50",
    draw: 40,
    level: 0.5,
    color: "red",
    weight: "primary",
  };
  const views: MarkerView[] = [
    {
      marker,
      x: 100,
      y: 50,
      label_x: 80,
      label_y: 50,
      text_anchor: "end",
      dominant_baseline: "auto",
      label_text: "P50",
    },
    {
      marker: { ...marker, key: "MEAN", label: "MEAN" },
      x: 112,
      y: 60,
      label_x: 92,
      label_y: 60,
      text_anchor: "end",
      dominant_baseline: "auto",
      label_text: "MEAN",
    },
  ];

  const adjusted_views = resolve_marker_label_collisions(views);

  assert.deepEqual(
    views.map((view) => view.label_y),
    [50, 60],
  );
  assert.notEqual(adjusted_views[1], views[1]);
  assert.equal(adjusted_views[0].label_y, 50);
  assert.equal(adjusted_views[1].label_y, 36);
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

test("build_visualize_view_model derives metric-aware values and markers", () => {
  const input: VisualizeInput = {
    title: "核心模拟结果",
    target: "target",
    metric: "cost",
    total: 100,
    note: "",
    timestamp: 0,
    values: [1, 2],
    cumulative: [0.5, 1],
    price: "单抽 10 RMB；十连抽 90 RMB",
    unit: "测试币",
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
    },
    termination_reason: [{ reason: "success", proportion: 100 }],
  };

  const normalized_input = normalize_input(input);
  assert.equal("metrics" in normalized_input, false);
  assert.equal("markers" in normalized_input, false);
  assert.equal(normalized_input.metric, "cost");
  assert.equal(normalized_input.total_display, "100 测试币");
  assert.equal(normalized_input.axis_title, "累计成本");
  assert.equal(normalized_input.price, "单抽 10 RMB；十连抽 90 RMB");

  const view_model = build_visualize_view_model(normalized_input);
  assert.deepEqual(
    view_model.metrics.map((metric) => metric.key),
    STATISTIC_VIEW_ORDER,
  );
  assert.equal(
    view_model.metrics.find((metric) => metric.key === "P50")?.display_value,
    "1",
  );
  assert.equal(
    view_model.markers.find((marker) => marker.key === "P50")?.weight,
    "primary",
  );
});

test("cost metric omits suffixes when unit and price are empty", () => {
  const normalized_input = normalize_input(
    make_valid_input({
      metric: "cost",
      price: "",
      unit: "",
    }),
  );
  const view_model = build_visualize_view_model(normalized_input);

  assert.equal(normalized_input.total_display, "3");
  assert.equal(normalized_input.axis_title, "累计成本");
  assert.equal(normalized_input.price, "");
  assert.equal(
    view_model.metrics.find((metric) => metric.key === "P50")?.display_value,
    "2",
  );
});

test("segment_progress clamps before and after its time window", () => {
  assert.equal(segment_progress(99, 100, 200), 0);
  assert.equal(segment_progress(200, 100, 200), 0.5);
  assert.equal(segment_progress(301, 100, 200), 1);
});

test("build_animation_progress exposes final state at animation end", () => {
  const progress = build_animation_progress(ANIMATION_TOTAL_MS);

  assert.equal(progress.title_area(2).opacity, 1);
  assert.equal(progress.title_area(2).translate_x, 0);
  assert.equal(progress.metadata(2).opacity, 1);
  assert.equal(progress.metadata(2).translate_x, 0);
  assert.equal(progress.chart_shell.translate_y, 0);
  assert.equal(progress.chart_surface.opacity, 1);
  assert.equal(progress.curve, 1);
  assert.equal(progress.marker_line(0).scale, 1);
  assert.equal(progress.marker_group(0).opacity, 1);
  assert.equal(progress.pk_fill, 1);
  assert.equal(progress.stat_content(3).translate_x, 0);
  assert.equal(progress.note.opacity, 1);
});

test("title completes before curve and metadata follows statistic panel", () => {
  assert.equal(
    ANIMATION_TIMELINE.TITLE_AREA_DELAY_MS +
      2 * ANIMATION_TIMELINE.TITLE_AREA_STAGGER_MS +
      ANIMATION_TIMELINE.TITLE_AREA_DURATION_MS <=
      ANIMATION_TIMELINE.CURVE_DELAY_MS,
    true,
  );
  assert.equal(
    ANIMATION_TIMELINE.METADATA_DELAY_MS,
    ANIMATION_TIMELINE.STAT_PANEL_DELAY_MS,
  );
  assert.equal(
    ANIMATION_TIMELINE.METADATA_DURATION_MS,
    ANIMATION_TIMELINE.STAT_PANEL_DURATION_MS,
  );
});

test("build_animation_progress staggers marker and stat content timing", () => {
  const marker_progress = build_animation_progress(
    ANIMATION_TIMELINE.MARKER_GROUP_DELAY_MS +
      Math.floor(ANIMATION_TIMELINE.MARKER_STAGGER_MS / 2),
  );
  assert.equal(marker_progress.marker_group(0).opacity > 0, true);
  assert.equal(marker_progress.marker_group(1).opacity, 0);

  const stat_progress = build_animation_progress(
    ANIMATION_TIMELINE.STAT_CONTENT_DELAY_MS +
      Math.floor(ANIMATION_TIMELINE.STAT_CONTENT_STAGGER_MS / 2),
  );
  assert.equal(stat_progress.stat_content(0).opacity > 0, true);
  assert.equal(stat_progress.stat_content(1).opacity, 0);
});
