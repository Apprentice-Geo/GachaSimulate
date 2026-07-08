import type { ScaleFunction } from "recharts";
import type { CDFMarker, CDFPoint } from "../types/visualize_input";
import { CDF_MARKER_VIEW_CONFIG } from "./cdf_view_config";

export interface MarkerView {
  marker: CDFMarker;
  x: number;
  y: number;
  label_x: number;
  label_y: number;
  text_anchor: "start" | "middle" | "end";
  dominant_baseline: "auto" | "hanging" | "middle" | "text-after-edge";
  label_text: string;
}

export interface PlotBox {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export interface ChartPlotArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function estimate_label_width(label: string): number {
  return label.length * 19.2;
}

function clamp_label_x(
  x: number,
  text_anchor: MarkerView["text_anchor"],
  label_text: string,
  plot_box: PlotBox,
): number {
  const label_width = estimate_label_width(label_text);
  if (text_anchor === "end") {
    return clamp(x, plot_box.left + label_width, plot_box.right - 8);
  }
  if (text_anchor === "start") {
    return clamp(x, plot_box.left + 8, plot_box.right - label_width);
  }
  return clamp(
    x,
    plot_box.left + label_width / 2,
    plot_box.right - label_width / 2,
  );
}

export function resolve_marker_label_collisions(
  views: readonly MarkerView[],
): MarkerView[] {
  const adjusted_label_y_by_key = new Map<CDFMarker["key"], number>();
  const adjusted_sorted_views: MarkerView[] = [];

  [...views]
    .sort((a, b) => a.label_y - b.label_y)
    .forEach((view, index) => {
      const previous_view = adjusted_sorted_views[index - 1];
      let label_y = view.label_y;

      if (previous_view) {
        const is_neighboring =
          Math.abs(view.x - previous_view.x) < 152 &&
          Math.abs(label_y - previous_view.label_y) < 32;
        if (is_neighboring) {
          label_y += index % 2 === 0 ? 24 : -24;
        }
      }

      adjusted_label_y_by_key.set(view.marker.key, label_y);
      adjusted_sorted_views.push({ ...view, label_y });
    });

  return views.map((view) => ({
    ...view,
    label_y: adjusted_label_y_by_key.get(view.marker.key) ?? view.label_y,
  }));
}

export function build_marker_views(
  markers: CDFMarker[],
  plot_area: ChartPlotArea | undefined,
  x_scale: ScaleFunction | undefined,
  y_scale: ScaleFunction | undefined,
): MarkerView[] {
  if (!plot_area || !x_scale || !y_scale) {
    return [];
  }

  const plot_box: PlotBox = {
    left: plot_area.x,
    top: plot_area.y,
    width: plot_area.width,
    height: plot_area.height,
    right: plot_area.x + plot_area.width,
    bottom: plot_area.y + plot_area.height,
  };
  const p50 = markers.find((marker) => marker.key === "P50");
  const mean = markers.find((marker) => marker.key === "MEAN");
  const p50_is_greater_than_mean = (p50?.draw ?? 0) > (mean?.draw ?? 0);

  const views = markers.flatMap((marker) => {
    const x = x_scale(marker.draw);
    const marker_level =
      CDF_MARKER_VIEW_CONFIG[marker.key].quantile_level ?? marker.level;
    const y = y_scale(clamp(marker_level, 0, 1));
    if (x === undefined || y === undefined) {
      return [];
    }

    let label_x = x - 16;
    let label_y = y - 20;
    let text_anchor: MarkerView["text_anchor"] = "end";
    let dominant_baseline: MarkerView["dominant_baseline"] = "auto";
    let label_text = marker.label;

    if (marker.key === "MEAN") {
      label_x = x - 28;
      label_y = y;
      text_anchor = "end";
      dominant_baseline = p50_is_greater_than_mean
        ? "hanging"
        : "text-after-edge";
      label_text = "MEAN ";
    }

    if (marker.key === "MAX") {
      label_x = x - 24;
      label_y = y - 20;
      text_anchor = "end";
      dominant_baseline = "text-after-edge";
      label_text = "MAX ";
    }

    if (marker.key === "P50") {
      label_x = x - 28;
      label_y = y;
      text_anchor = "end";
      dominant_baseline = p50_is_greater_than_mean
        ? "text-after-edge"
        : "hanging";
      label_text = "P50 ";
    }

    return {
      marker,
      x,
      y,
      label_x,
      label_y,
      text_anchor,
      dominant_baseline,
      label_text,
    };
  });

  return resolve_marker_label_collisions(views).map((view) => ({
    ...view,
    label_x: clamp_label_x(
      view.label_x,
      view.text_anchor,
      view.label_text,
      plot_box,
    ),
    label_y: clamp(view.label_y, 48, plot_box.bottom - 16),
  }));
}

export function build_curve_path(
  chart_points: CDFPoint[],
  x_scale: ScaleFunction | undefined,
  y_scale: ScaleFunction | undefined,
): string {
  if (!x_scale || !y_scale || chart_points.length === 0) {
    return "";
  }

  const path_segments: string[] = [];
  let previous_y = 0;

  chart_points.forEach((point) => {
    const x = x_scale(point.draw);
    const y = y_scale(clamp(point.cumulative, 0, 1));
    if (x === undefined || y === undefined) {
      return;
    }

    if (path_segments.length === 0) {
      path_segments.push(`M ${x.toFixed(2)} ${y.toFixed(2)}`);
    } else {
      path_segments.push(`L ${x.toFixed(2)} ${previous_y.toFixed(2)}`);
      path_segments.push(`L ${x.toFixed(2)} ${y.toFixed(2)}`);
    }

    previous_y = y;
  });

  return path_segments.join(" ");
}
