export interface TerminationReasonInput {
  reason: string;
  proportion: number;
}

export const VISUALIZE_INPUT_REQUIRED_KEYS = [
  "title",
  "target",
  "result_item",
  "total",
  "runs",
  "note",
  "statistic",
  "termination_reason",
  "timestamp",
  "values",
  "cumulative",
  "price",
  "unit",
] as const;

export const VISUALIZE_STATISTIC_REQUIRED_KEYS = [
  "P5",
  "P25",
  "P50",
  "P75",
  "P95",
  "MIN",
  "MEAN_LEVEL",
  "MEAN",
  "MAX",
] as const;

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
}

export interface VisualizeInput {
  title: string;
  target: string;
  result_item: { id: string; name: string };
  total: number;
  runs: number;
  note: string;
  statistic: VisualizeStatisticInput;
  termination_reason: TerminationReasonInput[];
  timestamp: number;
  values: number[];
  cumulative: number[];
  price: string;
  unit: string;
}

export type StatisticKey =
  | "P5"
  | "P25"
  | "P50"
  | "P75"
  | "P95"
  | "MEAN"
  | "MIN"
  | "MAX";

export type MarkerKey =
  | "MIN"
  | "P5"
  | "P25"
  | "P50"
  | "MEAN"
  | "P75"
  | "P95"
  | "MAX";

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

export interface CDFMarker {
  key: MarkerKey;
  label: string;
  draw: number;
  level: number;
  color: string;
  weight: "faint" | "normal" | "strong" | "primary";
}

export interface CDFMarkerDatum {
  key: MarkerKey;
  draw: number;
  level: number;
}

export interface NormalizedVisualizeInputData {
  title: string;
  target: string;
  result_item: { id: string; name: string };
  total: number;
  runs: number;
  total_display: string;
  display_unit: string;
  axis_title: string;
  price: string;
  unit: string;
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
}
