import { build_chart_points } from './cdf';
import type {
  NormalizedVisualizeInputData,
  VisualizeInput,
} from '../types/visualize_input';

function format_number(value: number, fraction_digits = 0): string {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: fraction_digits,
  }).format(value);
}

export function normalize_input(input: VisualizeInput): NormalizedVisualizeInputData {
  const chart_points = build_chart_points(input);
  const max_draw = Math.max(...input.draws, input.statistic.MAX);
  const x_domain_max = Math.max(1, Math.ceil(max_draw * 1.04));

  return {
    title: input.title,
    target: input.target,
    draw_counts: input.draw_counts,
    draw_counts_display: format_number(input.draw_counts),
    note: input.note,
    timestamp: input.timestamp,
    chart_points,
    statistic: input.statistic,
    termination_reason: input.termination_reason,
    x_domain_max,
  };
}
