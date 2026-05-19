export interface TerminationReasonInput {
  reason: string;
  proportion: number;
}

export interface VisualizeStatisticInput {
  P5: number;
  P25: number;
  P50: number;
  P75: number;
  P95: number;
  MIN: number;
  MEAN_LEVEL: number;
  MEAN: number;
  MAX: number;
  COST: number;
}

export interface VisualizeInput {
  title: string;
  target: string;
  draw_counts: number;
  note: string;
  statistic: VisualizeStatisticInput;
  termination_reason: TerminationReasonInput[];
  timestamp: number;
  draws: number[];
  cumulative: number[];
}

export type StatisticKey =
  | 'P5'
  | 'P25'
  | 'P50'
  | 'P75'
  | 'P95'
  | 'MEAN'
  | 'MIN'
  | 'MAX';

export type MarkerKey =
  | 'MIN'
  | 'P5'
  | 'P25'
  | 'P50'
  | 'MEAN'
  | 'P75'
  | 'P95'
  | 'MAX';

export interface CDFPoint {
  draw: number;
  cumulative: number;
}

export interface StatisticMetric {
  key: StatisticKey;
  label: string;
  value: number;
  display_value: string;
  color: string;
}

export interface CostMetric {
  value: number;
  display_value: string;
  unit: 'RMB';
}

export interface CDFMarker {
  key: MarkerKey;
  label: string;
  draw: number;
  level: number;
  color: string;
  weight: 'faint' | 'normal' | 'strong' | 'primary';
}

export interface CDFMarkerDatum {
  key: MarkerKey;
  draw: number;
  level: number;
}

export interface NormalizedVisualizeInputData {
  title: string;
  target: string;
  draw_counts: number;
  draw_counts_display: string;
  note: string;
  timestamp: number;
  chart_points: CDFPoint[];
  statistic: VisualizeStatisticInput;
  termination_reason: TerminationReasonInput[];
  x_domain_max: number;
}

export interface NormalizedVisualizeData extends NormalizedVisualizeInputData {
  metrics: StatisticMetric[];
  markers: CDFMarker[];
  cost: CostMetric;
}
