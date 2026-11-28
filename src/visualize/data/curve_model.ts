import {
  consume_wire_parsed_analysis,
  parse_canonical_u64,
  validate_and_parse_analysis,
} from "./analysis";
import { validate_display_config } from "./validate_display_config";
import type { Analysis, TerminationReason } from "../types/analysis";
import type { MarkerKey, StatisticKey } from "../types/cdf";
import type { DisplayConfig } from "../types/display_config";
import { CDF_MARKER_VIEW_CONFIG } from "../view/cdf_view_config";
import {
  STATISTIC_VIEW_CONFIG,
  STATISTIC_VIEW_ORDER,
} from "../view/statistic_view_config";

const RATIO_PRECISION = 1_000_000_000_000n;
const RATIO_DIVISOR = 1_000_000_000_000;

const STATISTIC_KEYS: readonly StatisticKey[] = [
  "P5",
  "P25",
  "P50",
  "P75",
  "P95",
  "MIN",
  "MEAN",
  "MAX",
];

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

export interface ExactCDFPoint {
  readonly draw: bigint;
  readonly draw_text: string;
  readonly x_ratio: number;
  readonly cumulative: number;
}

export interface ExactStatisticReading {
  readonly value: bigint;
  readonly text: string;
}

export type ExactStatisticValues = Readonly<
  Record<StatisticKey, ExactStatisticReading> & {
    readonly MEAN_LEVEL: number;
  }
>;

export interface ExactCDFMarker {
  readonly key: MarkerKey;
  readonly label: string;
  readonly draw: bigint;
  readonly draw_text: string;
  readonly x_ratio: number;
  readonly level: number;
  readonly color: string;
  readonly weight: "faint" | "normal" | "strong" | "primary";
}

export interface ExactStatisticMetric {
  readonly key: StatisticKey;
  readonly label: string;
  readonly value: bigint;
  readonly value_text: string;
  readonly display_value: string;
  readonly color: string;
}

export interface PreparedCurveData {
  readonly result_item: { readonly id: string; readonly name: string };
  readonly runs: bigint;
  readonly runs_text: string;
  readonly total_result: bigint;
  readonly total_result_text: string;
  readonly statistic: ExactStatisticValues;
  readonly x_domain_min: bigint;
  readonly x_domain_max: bigint;
  readonly chart_points: readonly ExactCDFPoint[];
  readonly markers: readonly ExactCDFMarker[];
  readonly termination_reason: readonly TerminationReason[];
}

export interface CurveViewModel {
  readonly title: string;
  readonly target: string;
  readonly result_item: { readonly id: string; readonly name: string };
  readonly total_result: bigint;
  readonly total_result_text: string;
  readonly total_result_display: string;
  readonly runs: bigint;
  readonly runs_text: string;
  readonly result_item_unit: string;
  readonly axis_title: string;
  readonly subtitle: string;
  readonly note: string;
  readonly x_domain_min: bigint;
  readonly x_domain_max: bigint;
  readonly chart_points: readonly ExactCDFPoint[];
  readonly termination_reason: readonly TerminationReason[];
  readonly metrics: readonly ExactStatisticMetric[];
  readonly markers: readonly ExactCDFMarker[];
}

export function parse_u64_bigint(value: string, label: string): bigint {
  return parse_canonical_u64(value, label);
}

export function compute_x_domain_max(max_draw: bigint): bigint {
  if (max_draw <= 0n) return 1n;
  const padded = (max_draw * 104n + 99n) / 100n;
  return padded > 1n ? padded : 1n;
}

/**
 * Maps an exact non-negative BigInt draw onto [0, 1] plotting coordinates
 * without losing precision or overflowing JS numbers for values up to u64::MAX.
 */
export function draw_to_plot_ratio(draw: bigint, x_domain_max: bigint): number {
  if (x_domain_max <= 0n || draw <= 0n) return 0;
  if (draw >= x_domain_max) return 1;
  const scaled = (draw * RATIO_PRECISION) / x_domain_max;
  return Number(scaled) / RATIO_DIVISOR;
}

export function get_cdf_level_at_exact_draw(
  points: readonly ExactCDFPoint[],
  draw: bigint,
): number {
  if (points.length === 0) return 0;
  if (draw <= points[0].draw) return points[0].cumulative;

  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (points[mid].draw <= draw) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return points[low].cumulative;
}

export function prepare_curve_data(input: Analysis): PreparedCurveData {
  const parsed =
    consume_wire_parsed_analysis(input) ?? validate_and_parse_analysis(input);
  const { analysis, runs, total_result } = parsed;

  const stat_entries: Partial<Record<StatisticKey, ExactStatisticReading>> = {};
  for (const key of STATISTIC_KEYS) {
    stat_entries[key] = {
      value: parsed.statistic[key],
      text: analysis.statistic[key],
    };
  }
  const statistic = {
    ...(stat_entries as Record<StatisticKey, ExactStatisticReading>),
    MEAN_LEVEL: analysis.statistic.MEAN_LEVEL,
  };

  const point_count = parsed.values.length;
  const max_observed = parsed.values[point_count - 1];
  const max_draw =
    statistic.MAX.value > max_observed ? statistic.MAX.value : max_observed;
  const x_domain_max = compute_x_domain_max(max_draw);

  const chart_points = new Array<ExactCDFPoint>(point_count);
  for (let index = 0; index < point_count; index += 1) {
    const draw = parsed.values[index];
    chart_points[index] = {
      draw,
      draw_text: analysis.values[index],
      x_ratio: draw_to_plot_ratio(draw, x_domain_max),
      cumulative: analysis.cumulative[index],
    };
  }

  const markers: ExactCDFMarker[] = MARKER_KEYS.map((key) => {
    const config = CDF_MARKER_VIEW_CONFIG[key];
    const reading = statistic[key];
    return {
      key,
      label: config.label,
      draw: reading.value,
      draw_text: reading.text,
      x_ratio: draw_to_plot_ratio(reading.value, x_domain_max),
      level:
        key === "MEAN"
          ? statistic.MEAN_LEVEL
          : get_cdf_level_at_exact_draw(chart_points, reading.value),
      color: config.color,
      weight: config.weight,
    };
  });

  return {
    result_item: { ...analysis.result_item },
    runs,
    runs_text: analysis.totals.runs,
    total_result,
    total_result_text: analysis.totals.result,
    statistic,
    x_domain_min: 0n,
    x_domain_max,
    chart_points,
    markers,
    termination_reason: analysis.termination_reason.map((entry) => ({
      ...entry,
    })),
  };
}

export function apply_curve_display(
  data: PreparedCurveData,
  input_display: DisplayConfig,
): CurveViewModel {
  const display = validate_display_config(input_display);
  const result_item = {
    id: data.result_item.id,
    name: display.result_item_name,
  };
  const format_value = (exact_text: string) =>
    display.result_item_unit
      ? `${exact_text} ${display.result_item_unit}`
      : exact_text;

  return {
    title: display.title,
    target: display.target,
    result_item,
    total_result: data.total_result,
    total_result_text: data.total_result_text,
    total_result_display: format_value(data.total_result_text),
    runs: data.runs,
    runs_text: data.runs_text,
    result_item_unit: display.result_item_unit,
    axis_title: `结束时的${result_item.name}`,
    subtitle: display.subtitle,
    note: display.note,
    x_domain_min: data.x_domain_min,
    x_domain_max: data.x_domain_max,
    chart_points: data.chart_points,
    termination_reason: data.termination_reason,
    metrics: STATISTIC_VIEW_ORDER.map((key) => ({
      key,
      label: STATISTIC_VIEW_CONFIG[key].label,
      value: data.statistic[key].value,
      value_text: data.statistic[key].text,
      display_value: format_value(data.statistic[key].text),
      color: CDF_MARKER_VIEW_CONFIG[key].color,
    })),
    markers: data.markers,
  };
}

export function build_curve_view_model(
  analysis: Analysis,
  display: DisplayConfig,
): CurveViewModel {
  return apply_curve_display(prepare_curve_data(analysis), display);
}
