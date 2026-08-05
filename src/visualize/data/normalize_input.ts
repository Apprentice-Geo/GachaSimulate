import { build_chart_points } from "./cdf";
import type {
  NormalizedVisualizeInputData,
  VisualizeInput,
} from "../types/visualize_input";

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
  const display_unit = input.metric === "draw" ? "抽" : input.unit;
  const metric_label = input.metric === "draw" ? "抽数" : "成本";
  const axis_title = input.metric === "draw" ? "累计抽数" : "累计成本";

  return {
    title: input.title,
    target: input.target,
    metric: input.metric,
    metric_label,
    total: input.total,
    total_display: append_unit(format_number(input.total), display_unit),
    display_unit,
    axis_title,
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
