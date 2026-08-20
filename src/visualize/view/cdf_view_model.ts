import { get_cdf_level_at_draw } from "../data/cdf";
import type { AnalysisV2 } from "../types/analysis";
import type {
  CDFMarker,
  CDFViewModel,
  MarkerKey,
  StatisticKey,
  StatisticValues,
} from "../types/cdf";
import type { DisplayConfig } from "../types/display_config";
import { CDF_MARKER_VIEW_CONFIG } from "./cdf_view_config";
import {
  STATISTIC_VIEW_CONFIG,
  STATISTIC_VIEW_ORDER,
} from "./statistic_view_config";

function non_negative(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${name} is outside the supported visualization range`);
  }
  return number;
}

function format_number(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
  }).format(value);
}

function get_metric_color(key: StatisticKey): string {
  return CDF_MARKER_VIEW_CONFIG[key].color;
}

export function build_cdf_view_model(
  analysis: AnalysisV2,
  display: DisplayConfig,
): CDFViewModel {
  const number = (value: string, name: string) => non_negative(value, name);
  const statistic = Object.fromEntries(
    ["P5", "P25", "P50", "P75", "P95", "MIN", "MEAN", "MAX"].map((key) => [
      key,
      number(
        analysis.statistic[key as keyof typeof analysis.statistic] as string,
        `statistic.${key}`,
      ),
    ]),
  ) as unknown as StatisticValues;
  statistic.MEAN_LEVEL = analysis.statistic.MEAN_LEVEL;

  const values = analysis.values.map((value, index) =>
    number(value, `values[${index}]`),
  );
  const chart_points = values.map((draw, index) => ({
    draw,
    cumulative: analysis.cumulative[index],
  }));
  const marker_keys: MarkerKey[] = [
    "MIN",
    "P5",
    "P25",
    "P50",
    "MEAN",
    "P75",
    "P95",
    "MAX",
  ];
  const markers: CDFMarker[] = marker_keys.map((key) => {
    const config = CDF_MARKER_VIEW_CONFIG[key];
    return {
      key,
      draw: statistic[key],
      level:
        key === "MEAN"
          ? statistic.MEAN_LEVEL
          : get_cdf_level_at_draw(chart_points, statistic[key]),
      label: config.label,
      color: config.color,
      weight: config.weight,
    };
  });
  const result_item = {
    ...analysis.result_item,
    name: display.result_item_name,
  };
  const total = number(analysis.totals.result, "totals.result");

  return {
    title: display.title,
    target: display.target,
    result_item,
    total,
    total_display: display.unit
      ? `${format_number(total)} ${display.unit}`
      : format_number(total),
    runs: number(analysis.totals.runs, "totals.runs"),
    display_unit: display.unit,
    axis_title: `结束时的${result_item.name}`,
    price: display.price,
    note: display.note,
    chart_points,
    termination_reason: analysis.termination_reason,
    x_domain_max: Math.max(
      1,
      Math.ceil(Math.max(...values, statistic.MAX) * 1.04),
    ),
    metrics: STATISTIC_VIEW_ORDER.map((key) => ({
      key,
      label: STATISTIC_VIEW_CONFIG[key].label,
      value: statistic[key],
      display_value: format_number(statistic[key]),
      color: get_metric_color(key),
    })),
    markers,
  };
}
