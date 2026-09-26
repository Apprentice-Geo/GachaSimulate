import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  EXPORT_FRAME_COUNT,
  resolve_export_frame_state,
} from "../animation/export_frame";
import {
  build_animation_progress,
  build_marker_line_order,
  ease_out_cubic,
  ease_out_quad,
  linear,
  segment_progress,
} from "../animation/progress";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../constants";
import { get_cdf_level_at_draw } from "../data/cdf";
import { build_cdf_view_model } from "../view/cdf_view_model";
import {
  build_curve_path,
  build_marker_views,
  resolve_marker_label_collisions,
} from "../view/cdf_overlay_layout";
import { STATISTIC_VIEW_ORDER } from "../view/statistic_view_config";
import {
  ANIMATION_COMPLETION_FRAME,
  ANIMATION_TIMELINE,
  ANIMATION_TOTAL_MS,
  MARKER_GROUP_START_FRAME,
} from "../animation/timeline";
import type { MarkerView } from "../view/cdf_overlay_layout";
import type { CDFMarker, CDFViewModel, MarkerKey } from "../types/cdf";
import type { Analysis } from "../types/analysis";
import type { DisplayConfig } from "../types/display_config";
import { CDFChart } from "../components/CDFChart";
import { VisualizeShell } from "../components/VisualizeShell";
import { VisualizeScene } from "../VisualizeScene";

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

test("build_cdf_view_model normalizes Analysis and display fields together", () => {
  const analysis: Analysis = {
    result_item: { id: "tokens", name: "内部名称" },
    totals: { runs: "4", result: "100" },
    values: ["1", "2", "3"],
    cumulative: [0.25, 0.75, 1],
    statistic: {
      P5: "1",
      P25: "1",
      P50: "2",
      P75: "2",
      P95: "3",
      MIN: "1",
      MEAN_LEVEL: 0.75,
      MEAN: "2",
      MAX: "3",
    },
    termination_reason: [{ reason: "done", proportion: 100 }],
  };
  const display: DisplayConfig = {
    display_version: 2,
    title: "展示标题",
    target: "展示目标",
    result_item_name: "代币",
    note: "说明",
    subtitle: "兑换结果",
    result_item_unit: "测试币",
  };

  const view_model = build_cdf_view_model(analysis, display);

  assert.equal(view_model.title, display.title);
  assert.equal(view_model.subtitle, display.subtitle);
  assert.deepEqual(view_model.result_item, { id: "tokens", name: "代币" });
  assert.equal(view_model.total_result, 100);
  assert.equal(view_model.total_result_display, "100 测试币");
  assert.equal(view_model.runs, 4);
  assert.equal(view_model.result_item_unit, display.result_item_unit);
  assert.equal(view_model.axis_title, "结束时的代币");
  assert.deepEqual(
    view_model.metrics.map((metric) => metric.key),
    STATISTIC_VIEW_ORDER,
  );
  assert.equal(
    view_model.markers.find((marker) => marker.key === "P50")?.weight,
    "primary",
  );
  assert.equal(
    view_model.metrics.find((metric) => metric.key === "P50")?.value,
    2,
  );
  assert.deepEqual(
    view_model.metrics.map((metric) => metric.display_value),
    [
      "1 测试币",
      "1 测试币",
      "2 测试币",
      "2 测试币",
      "3 测试币",
      "2 测试币",
      "1 测试币",
      "3 测试币",
    ],
  );

  const without_unit = build_cdf_view_model(analysis, {
    ...display,
    result_item_unit: "",
  });
  assert.equal(without_unit.total_result_display, "100");
  assert.deepEqual(
    without_unit.metrics.map((metric) => metric.display_value),
    ["1", "1", "2", "2", "3", "2", "1", "3"],
  );
  assert.equal(without_unit.axis_title, view_model.axis_title);
  assert.deepEqual(without_unit.chart_points, view_model.chart_points);
  assert.equal(without_unit.x_domain_max, view_model.x_domain_max);
});

test("build_cdf_view_model rejects negative and unsafe Analysis numbers", () => {
  const analysis: Analysis = {
    result_item: { id: "draw_count", name: "抽数" },
    totals: { runs: "1", result: "1" },
    values: ["1"],
    cumulative: [1],
    statistic: {
      P5: "1",
      P25: "1",
      P50: "1",
      P75: "1",
      P95: "1",
      MIN: "1",
      MEAN_LEVEL: 1,
      MEAN: "1",
      MAX: "1",
    },
    termination_reason: [{ reason: "done", proportion: 100 }],
  };
  const display: DisplayConfig = {
    display_version: 2,
    title: "标题",
    target: "目标",
    result_item_name: "抽数",
    note: "",
    subtitle: "",
    result_item_unit: "",
  };

  assert.throws(() =>
    build_cdf_view_model({ ...analysis, values: ["-1"] }, display),
  );
  assert.throws(() =>
    build_cdf_view_model(
      {
        ...analysis,
        statistic: { ...analysis.statistic, MAX: "9007199254740992" },
      },
      display,
    ),
  );
});

function frame_to_ms(frame: number): number {
  return (frame / 60) * 1000;
}

const MARKER_KEYS: readonly MarkerKey[] = [
  "MIN",
  "P5",
  "P25",
  "P50",
  "MEAN",
  "P75",
  "P95",
  "MAX",
];

test("animation easing functions and segments expose exact endpoints", () => {
  assert.deepEqual([linear(0), linear(0.5), linear(1)], [0, 0.5, 1]);
  assert.deepEqual(
    [ease_out_quad(0), ease_out_quad(0.5), ease_out_quad(1)],
    [0, 0.75, 1],
  );
  assert.deepEqual(
    [ease_out_cubic(0), ease_out_cubic(0.5), ease_out_cubic(1)],
    [0, 0.875, 1],
  );
  assert.equal(segment_progress(9, 10, 20, linear), 0);
  assert.equal(segment_progress(15, 10, 20, linear), 0.5);
  assert.equal(segment_progress(21, 10, 20, linear), 1);
});

test("every animation segment spans at least five frames", () => {
  const fixed_segments = [
    ANIMATION_TIMELINE.CHART_SHELL,
    ANIMATION_TIMELINE.CHART_SURFACE,
    ANIMATION_TIMELINE.CURVE,
    ANIMATION_TIMELINE.STAT_SURFACE,
    ANIMATION_TIMELINE.TERMINATION_SURFACE,
    ANIMATION_TIMELINE.TERMINATION_TITLE,
    ANIMATION_TIMELINE.PK_FILL,
    ANIMATION_TIMELINE.TERMINATION_DETAIL,
    ANIMATION_TIMELINE.MEAN_LINE,
    ANIMATION_TIMELINE.NOTE,
  ];
  const durations = [
    ...fixed_segments.map(
      (segment) => segment.completion_frame - segment.start_frame,
    ),
    ANIMATION_TIMELINE.TITLE_AREA.completion_frame -
      ANIMATION_TIMELINE.TITLE_AREA.start_frame,
    ANIMATION_TIMELINE.METADATA.completion_frame -
      ANIMATION_TIMELINE.METADATA.start_frame,
    ANIMATION_TIMELINE.STAT_CONTENT.completion_frame -
      ANIMATION_TIMELINE.STAT_CONTENT.start_frame,
    ANIMATION_TIMELINE.MARKER_LINE.completion_frame -
      ANIMATION_TIMELINE.MARKER_LINE.start_frame,
    ANIMATION_TIMELINE.MARKER_GROUP_DURATION_FRAMES,
  ];

  assert.equal(
    durations.every((duration) => duration >= 5),
    true,
  );
});

test("timeline elements use their assigned easing at segment midpoints", () => {
  const at_frame = (frame: number) =>
    build_animation_progress(frame_to_ms(frame));

  assert.equal(at_frame(5).chart_shell.opacity, 0.75);
  assert.equal(at_frame(6).title_area(0).opacity, 0.875);
  assert.equal(at_frame(13).chart_surface.opacity, 0.75);
  assert.equal(at_frame(32).curve, 0.5);
  assert.equal(at_frame(32).metadata(0).opacity, 0.875);
  assert.equal(at_frame(36).stat_surface.opacity, 0.75);
  assert.equal(at_frame(35).stat_content(0).opacity, 0.75);
  assert.equal(at_frame(40).termination_surface.opacity, 0.75);
  assert.equal(at_frame(39).termination_title.opacity, 0.75);
  assert.equal(at_frame(43.5).pk_fill, 0.75);
  assert.equal(at_frame(46.5).termination_detail.opacity, 0.75);
  assert.equal(at_frame(38.5).marker_line(0).opacity, 0.75);
  assert.equal(at_frame(46.5).marker_group("P50").opacity, 0.75);
  assert.equal(at_frame(47).mean_line.opacity, 0.85 * 0.75);
  assert.equal(at_frame(50.5).note.opacity, 0.75);
});

test("title and chart surface finish when the curve starts", () => {
  const latest_title_completion =
    ANIMATION_TIMELINE.TITLE_AREA.completion_frame +
    2 * ANIMATION_TIMELINE.TITLE_AREA.stagger_frames;
  assert.equal(
    latest_title_completion <= ANIMATION_TIMELINE.CURVE.start_frame,
    true,
  );
  assert.equal(
    ANIMATION_TIMELINE.CHART_SURFACE.completion_frame,
    ANIMATION_TIMELINE.CURVE.start_frame,
  );
});

test("marker lines use spatial order with stable semantic ties", () => {
  assert.deepEqual(
    build_marker_line_order([
      { key: "P50", position: 50 },
      { key: "MEAN", position: 40 },
      { key: "MIN", position: 10 },
    ]),
    ["MIN", "MEAN", "P50"],
  );
  assert.deepEqual(
    build_marker_line_order([
      { key: "P50", position: 40 },
      { key: "MEAN", position: 50 },
      { key: "MAX", position: 80 },
    ]),
    ["P50", "MEAN", "MAX"],
  );
  assert.deepEqual(
    build_marker_line_order(
      [...MARKER_KEYS].reverse().map((key) => ({ key, position: 40 })),
    ),
    MARKER_KEYS,
  );

  const between_first_two_starts = build_animation_progress(frame_to_ms(35.5));
  assert.equal(between_first_two_starts.marker_line(0).opacity > 0, true);
  assert.equal(between_first_two_starts.marker_line(1).opacity, 0);
  const after_second_start = build_animation_progress(frame_to_ms(36.5));
  assert.equal(after_second_start.marker_line(1).opacity > 0, true);
});

test("marker groups follow semantic batches keyed by MarkerKey", () => {
  assert.deepEqual(MARKER_GROUP_START_FRAME, {
    P50: 42,
    MEAN: 42,
    P25: 44,
    P75: 44,
    P5: 46,
    P95: 46,
    MIN: 48,
    MAX: 48,
  });
  const progress = build_animation_progress(frame_to_ms(43.5));
  assert.equal(progress.marker_group("P50").opacity > 0, true);
  assert.equal(progress.marker_group("MEAN").opacity > 0, true);
  assert.equal(progress.marker_group("P25").opacity, 0);
});

test("frame 56 is unfinished and frame 57 is the complete state", () => {
  const before_completion = build_animation_progress(frame_to_ms(56));
  assert.equal(before_completion.marker_line(7).scale < 1, true);
  assert.equal(before_completion.marker_group("MAX").opacity < 1, true);
  assert.equal(before_completion.note.opacity < 1, true);

  const progress = build_animation_progress(frame_to_ms(57));
  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(progress.title_area(index), {
      opacity: 1,
      translate_x: 0,
    });
    assert.deepEqual(progress.metadata(index), {
      opacity: 1,
      translate_x: 0,
    });
  }
  assert.deepEqual(progress.chart_shell, { opacity: 1, translate_y: 0 });
  assert.deepEqual(progress.chart_surface, { opacity: 1, translate_y: 0 });
  assert.equal(progress.curve, 1);
  assert.deepEqual(progress.mean_line, { opacity: 0.85, scale: 1 });
  assert.deepEqual(progress.stat_surface, { opacity: 1, translate_y: 0 });
  assert.deepEqual(progress.termination_surface, {
    opacity: 1,
    translate_y: 0,
  });
  assert.deepEqual(progress.termination_title, {
    opacity: 1,
    translate_y: 0,
  });
  assert.equal(progress.pk_fill, 1);
  assert.deepEqual(progress.termination_detail, {
    opacity: 1,
    translate_y: 0,
  });
  assert.deepEqual(progress.note, { opacity: 1, translate_y: 0 });
  for (let index = 0; index < 8; index += 1) {
    assert.deepEqual(progress.marker_line(index), { opacity: 1, scale: 1 });
  }
  for (const key of MARKER_KEYS) {
    assert.deepEqual(progress.marker_group(key), {
      opacity: 1,
      translate_y: 0,
    });
  }
  for (let index = 0; index < 11; index += 1) {
    assert.deepEqual(progress.stat_content(index), {
      opacity: 1,
      translate_x: 0,
    });
  }
});

function observable_animation_progress(frame: number) {
  const progress = build_animation_progress(
    resolve_export_frame_state(frame).elapsed_ms,
  );
  return {
    title: [0, 1, 2].map(progress.title_area),
    metadata: [0, 1, 2].map(progress.metadata),
    chart_shell: progress.chart_shell,
    chart_surface: progress.chart_surface,
    curve: progress.curve,
    mean_line: progress.mean_line,
    termination_surface: progress.termination_surface,
    termination_title: progress.termination_title,
    pk_fill: progress.pk_fill,
    termination_detail: progress.termination_detail,
    stat_surface: progress.stat_surface,
    note: progress.note,
    marker_lines: Array.from({ length: 8 }, (_, index) =>
      progress.marker_line(index),
    ),
    marker_groups: MARKER_KEYS.map(progress.marker_group),
    stat_content: Array.from({ length: 11 }, (_, index) =>
      progress.stat_content(index),
    ),
  };
}

test("export frame contract validates its exact integer range", () => {
  assert.equal(EXPORT_FRAME_COUNT, 60);
  for (const frame of [-1, 60, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => resolve_export_frame_state(frame), RangeError);
  }
});

test("export frame contract resolves playing and terminal states", () => {
  assert.equal(ANIMATION_COMPLETION_FRAME, 57);
  assert.equal(ANIMATION_TOTAL_MS, 950);
  assert.deepEqual(resolve_export_frame_state(0), {
    animation_state: "playing",
    elapsed_ms: 0,
    is_animating: true,
  });
  assert.deepEqual(resolve_export_frame_state(56), {
    animation_state: "playing",
    elapsed_ms: frame_to_ms(56),
    is_animating: true,
  });
  const terminal_state = {
    animation_state: "idle",
    elapsed_ms: ANIMATION_TOTAL_MS,
    is_animating: false,
  } as const;
  assert.deepEqual(resolve_export_frame_state(57), terminal_state);
  assert.deepEqual(resolve_export_frame_state(58), terminal_state);
  assert.deepEqual(resolve_export_frame_state(59), terminal_state);

  assert.deepEqual(
    observable_animation_progress(58),
    observable_animation_progress(57),
  );
  assert.deepEqual(
    observable_animation_progress(59),
    observable_animation_progress(57),
  );
});

test("VisualizeScene shares chart layout between interactive and export modes", () => {
  const animation_progress = build_animation_progress(ANIMATION_TOTAL_MS);
  const common_props = {
    animation_progress,
    animation_state: "idle" as const,
    data: {} as CDFViewModel,
    is_animating: false,
  };

  const interactive_scene = VisualizeScene({
    ...common_props,
    render_mode: "interactive",
  });
  assert.equal(interactive_scene.type, VisualizeShell);
  assert.equal(interactive_scene.props.render_mode, "interactive");
  assert.equal(interactive_scene.props.chart_slot.type, CDFChart);

  const export_scene = VisualizeScene({
    ...common_props,
    render_mode: "export",
  });
  assert.equal(export_scene.type, VisualizeShell);
  assert.equal(export_scene.props.render_mode, "export");
  assert.equal(export_scene.props.chart_slot.type, CDFChart);
  assert.deepEqual(
    export_scene.props.chart_slot.props,
    interactive_scene.props.chart_slot.props,
  );
});
