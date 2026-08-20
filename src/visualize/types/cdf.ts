import type { TerminationReason } from "./analysis";

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

export interface StatisticValues {
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

export interface CDFViewModel {
  title: string;
  target: string;
  result_item: { id: string; name: string };
  total: number;
  total_display: string;
  runs: number;
  display_unit: string;
  axis_title: string;
  price: string;
  note: string;
  chart_points: CDFPoint[];
  termination_reason: TerminationReason[];
  x_domain_max: number;
  metrics: StatisticMetric[];
  markers: CDFMarker[];
}
