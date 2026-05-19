import { build_chart_points } from './cdf';
import type {
  NormalizedVisualizeData,
  StatisticKey,
  StatisticMetric,
  VisualizeInput,
} from '../types/visualize_input';
import { build_markers, get_metric_color } from '../view/cdf_view_model';

// 这里控制核心统计量区域实际显示的文字
const METRIC_LABELS: Record<StatisticKey, string> = {
  P5: 'P5',
  P25: 'P25',
  P50: 'P50',
  P75: 'P75',
  P95: 'P95',
  MEAN: 'MEAN',
  MIN: 'MIN',
  MAX: 'MAX',
  COST: 'COST',
};

const METRIC_ORDER: StatisticKey[] = [
  'P5',
  'P25',
  'P50',
  'P75',
  'P95',
  'MEAN',
  'MIN',
  'MAX',
  'COST',
];

function format_number(value: number, fraction_digits = 0): string {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: fraction_digits,
  }).format(value);
}

function format_metric_value(key: StatisticKey, value: number): string {
  if (key === 'MEAN') {
    return format_number(value, Number.isInteger(value) ? 0 : 1);
  }
  return format_number(value);
}

function build_metrics(input: VisualizeInput): StatisticMetric[] {
  return METRIC_ORDER.map((key) => ({
    key,
    label: METRIC_LABELS[key],
    value: input.statistic[key],
    display_value: format_metric_value(key, input.statistic[key]),
    unit: key === 'COST' ? 'RMB' : '抽',
    color: get_metric_color(key),
  }));
}

export function normalize_input(input: VisualizeInput): NormalizedVisualizeData {
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
    metrics: build_metrics(input),
    markers: build_markers(input),
    termination_reason: input.termination_reason,
    x_domain_max,
  };
}
