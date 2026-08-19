import { build_marker_data, build_marker_data_from_points } from "../data/cdf";
import type {
  CDFMarker,
  NormalizedVisualizeData,
  NormalizedVisualizeInputData,
  StatisticKey,
  StatisticMetric,
  VisualizeInput,
} from "../types/visualize_input";
import { CDF_MARKER_VIEW_CONFIG } from "./cdf_view_config";
import { normalize_analysis_input } from "../data/normalize_input";
import type { AnalysisV2 } from "../types/analysis";
import type { DisplayConfig } from "../types/display_config";
import {
  STATISTIC_VIEW_CONFIG,
  STATISTIC_VIEW_ORDER,
} from "./statistic_view_config";

export function build_cdf_view_model(
  analysis: AnalysisV2,
  display: DisplayConfig,
): NormalizedVisualizeData {
  return build_visualize_view_model(
    normalize_analysis_input(analysis, display),
  );
}

function format_number(value: number, fraction_digits = 0): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: fraction_digits,
  }).format(value);
}

function format_metric_value(key: StatisticKey, value: number): string {
  return key === "MEAN"
    ? format_number(value, Number.isInteger(value) ? 0 : 1)
    : format_number(value);
}

export function build_markers(input: VisualizeInput): CDFMarker[] {
  return build_marker_data(input).map((marker) => {
    const config = CDF_MARKER_VIEW_CONFIG[marker.key];

    return {
      ...marker,
      label: config.label,
      color: config.color,
      weight: config.weight,
    };
  });
}

export function get_metric_color(key: StatisticKey): string {
  return CDF_MARKER_VIEW_CONFIG[key].color;
}

function build_metrics(input: NormalizedVisualizeInputData): StatisticMetric[] {
  return STATISTIC_VIEW_ORDER.map((key) => ({
    key,
    label: STATISTIC_VIEW_CONFIG[key].label,
    value: input.statistic[key],
    display_value: format_metric_value(key, input.statistic[key]),
    color: get_metric_color(key),
  }));
}

function build_markers_from_normalized(
  input: NormalizedVisualizeInputData,
): CDFMarker[] {
  return build_marker_data_from_points(input.chart_points, input.statistic).map(
    (marker) => {
      const config = CDF_MARKER_VIEW_CONFIG[marker.key];

      return {
        ...marker,
        label: config.label,
        color: config.color,
        weight: config.weight,
      };
    },
  );
}

export function build_visualize_view_model(
  input: NormalizedVisualizeInputData,
): NormalizedVisualizeData {
  return {
    ...input,
    metrics: build_metrics(input),
    markers: build_markers_from_normalized(input),
  };
}
