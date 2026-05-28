import type { CDFMarker, MarkerKey } from "../types/visualize_input";

interface CDFMarkerViewConfig {
  label: string;
  color: string;
  weight: CDFMarker["weight"];
  quantile_level?: number;
}

export const CDF_MARKER_VIEW_CONFIG: Record<MarkerKey, CDFMarkerViewConfig> = {
  MIN: {
    label: "MIN",
    color: "var(--color-cdf-marker-min)",
    weight: "faint",
  },
  P5: {
    label: "P5",
    color: "var(--color-cdf-marker-p5)",
    weight: "faint",
    quantile_level: 0.05,
  },
  P25: {
    label: "P25",
    color: "var(--color-cdf-marker-p25)",
    weight: "normal",
    quantile_level: 0.25,
  },
  P50: {
    label: "P50",
    color: "var(--color-cdf-marker-p50)",
    weight: "primary",
    quantile_level: 0.5,
  },
  MEAN: {
    label: "MEAN",
    color: "var(--color-cdf-marker-mean)",
    weight: "strong",
  },
  P75: {
    label: "P75",
    color: "var(--color-cdf-marker-p75)",
    weight: "normal",
    quantile_level: 0.75,
  },
  P95: {
    label: "P95",
    color: "var(--color-cdf-marker-p95)",
    weight: "strong",
    quantile_level: 0.95,
  },
  MAX: {
    label: "MAX",
    color: "var(--color-cdf-marker-max)",
    weight: "strong",
  },
};

export const CDF_CHART_VIEW_CONFIG = {
  curve_color: "var(--color-cdf-line)",
  grid_color: "var(--color-cdf-grid)",
  axis_color: "var(--color-cdf-axis)",
  x_tick_color: "var(--color-cdf-axis)",
  y_tick_color: "var(--color-cdf-axis-muted)",
  axis_tick_color: "var(--color-cdf-axis-tick)",
} as const;
