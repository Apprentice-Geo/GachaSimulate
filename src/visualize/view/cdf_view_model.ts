import { get_cdf_level_at_draw } from "../data/cdf";
import type { Analysis } from "../types/analysis";
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

export type PreparedCDFData = Pick<
  CDFViewModel,
  | "chart_points"
  | "markers"
  | "x_domain_max"
  | "runs"
  | "total_result"
  | "termination_reason"
> & { result_item: Analysis["result_item"]; statistic: StatisticValues };

export function prepare_cdf_data(analysis: Analysis): PreparedCDFData {
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
  return {
    result_item: analysis.result_item,
    statistic,
    total_result: number(analysis.totals.result, "totals.result"),
    runs: number(analysis.totals.runs, "totals.runs"),
    chart_points,
    markers,
    termination_reason: analysis.termination_reason,
    x_domain_max: Math.max(
      1,
      Math.ceil(Math.max(values[values.length - 1], statistic.MAX) * 1.04),
    ),
  };
}

export function apply_cdf_display(
  data: PreparedCDFData,
  display: DisplayConfig,
): CDFViewModel {
  const { statistic, total_result } = data;
  const result_item = { ...data.result_item, name: display.result_item_name };
  const format_result_item_value = (value: number) =>
    display.result_item_unit
      ? `${format_number(value)} ${display.result_item_unit}`
      : format_number(value);

  return {
    title: display.title,
    target: display.target,
    result_item,
    total_result,
    total_result_display: format_result_item_value(total_result),
    runs: data.runs,
    result_item_unit: display.result_item_unit,
    axis_title: `结束时的${result_item.name}`,
    subtitle: display.subtitle,
    note: display.note,
    chart_points: data.chart_points,
    termination_reason: data.termination_reason,
    x_domain_max: data.x_domain_max,
    metrics: STATISTIC_VIEW_ORDER.map((key) => ({
      key,
      label: STATISTIC_VIEW_CONFIG[key].label,
      value: statistic[key],
      display_value: format_result_item_value(statistic[key]),
      color: get_metric_color(key),
    })),
    markers: data.markers,
  };
}

export function build_cdf_view_model(
  analysis: Analysis,
  display: DisplayConfig,
): CDFViewModel {
  return apply_cdf_display(prepare_cdf_data(analysis), display);
}
