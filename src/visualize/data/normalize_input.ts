import { build_chart_points } from "./cdf";
import type {
  NormalizedVisualizeInputData,
  VisualizeInput,
} from "../types/visualize_input";
import type { AnalysisV2 } from "../types/analysis";
import type { DisplayConfig } from "../types/display_config";

function format_number(value: number, fraction_digits = 0): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: fraction_digits,
  }).format(value);
}

function append_unit(value: string, unit: string): string {
  return unit ? `${value} ${unit}` : value;
}

export function normalize_input(
  input: VisualizeInput,
): NormalizedVisualizeInputData {
  const chart_points = build_chart_points(input);
  const max_draw = Math.max(...input.values, input.statistic.MAX);
  const x_domain_max = Math.max(1, Math.ceil(max_draw * 1.04));
  const display_unit = input.unit;

  return {
    title: input.title,
    target: input.target,
    result_item: input.result_item,
    total: input.total,
    runs: input.runs,
    total_display: append_unit(format_number(input.total), display_unit),
    display_unit,
    axis_title: `结束时的${input.result_item.name}`,
    price: input.price,
    unit: input.unit,
    note: input.note,
    timestamp: input.timestamp,
    chart_points,
    statistic: input.statistic,
    termination_reason: input.termination_reason,
    x_domain_max,
  };
}

function non_negative(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${name} is outside the supported visualization range`);
  }
  return number;
}

export function build_cdf_view_model(
  analysis: AnalysisV2,
  display: DisplayConfig,
): NormalizedVisualizeInputData {
  const statistic = Object.fromEntries(
    ["P5", "P25", "P50", "P75", "P95", "MIN", "MEAN", "MAX"].map((key) => [
      key,
      non_negative(
        analysis.statistic[key as keyof typeof analysis.statistic] as string,
        `statistic.${key}`,
      ),
    ]),
  ) as unknown as VisualizeInput["statistic"];
  statistic.MEAN_LEVEL = analysis.statistic.MEAN_LEVEL;
  return normalize_input({
    title: display.title,
    target: display.target,
    result_item: { ...analysis.result_item, name: display.result_item_name },
    total: non_negative(analysis.totals.result, "totals.result"),
    runs: non_negative(analysis.totals.runs, "totals.runs"),
    note: display.note,
    statistic,
    termination_reason: analysis.termination_reason,
    timestamp: 0,
    values: analysis.values.map((value, index) =>
      non_negative(value, `values[${index}]`),
    ),
    cumulative: analysis.cumulative,
    price: display.price,
    unit: display.unit,
  });
}
