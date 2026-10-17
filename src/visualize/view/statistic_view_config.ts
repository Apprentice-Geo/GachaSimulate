import type { StatisticKey, StatisticMetric } from "../types/cdf";

interface StatisticViewConfig {
  label: string;
  value_size: "value" | "reading" | "hero";
}

export const STATISTIC_VIEW_CONFIG: Record<StatisticKey, StatisticViewConfig> =
  {
    P5: {
      label: "P5",
      value_size: "value",
    },
    P25: {
      label: "P25",
      value_size: "value",
    },
    P50: {
      label: "P50",
      value_size: "hero",
    },
    P75: {
      label: "P75",
      value_size: "value",
    },
    P95: {
      label: "P95",
      value_size: "reading",
    },
    MEAN: {
      label: "MEAN",
      value_size: "reading",
    },
    MIN: {
      label: "MIN",
      value_size: "value",
    },
    MAX: {
      label: "MAX",
      value_size: "value",
    },
  };

const QUANTILE_PERCENTAGES: Partial<Record<StatisticKey, number>> = {
  P5: 5,
  P25: 25,
  P50: 50,
  P75: 75,
  P95: 95,
};

export function get_statistic_description(key: StatisticKey): string {
  const percentage = QUANTILE_PERCENTAGES[key];
  if (percentage !== undefined) {
    return `第 ${percentage} 百分位`;
  }
  if (key === "MEAN") {
    return "平均结果";
  }
  return key === "MIN" ? "最小结果" : "最大结果";
}

export const STATISTIC_VIEW_ORDER = [
  "P5",
  "P25",
  "P50",
  "P75",
  "P95",
  "MEAN",
  "MIN",
  "MAX",
] as const satisfies readonly StatisticKey[];

const DISTRIBUTION_STATISTIC_GROUPS = [
  {
    id: "key-metrics",
    title: "关键指标",
    accent: "var(--color-rarity-gold)",
    emphasis: "primary",
    keys: ["P50", "MEAN", "P95"],
  },
  {
    id: "distribution-index",
    title: "分布索引",
    accent: "var(--color-rarity-purple)",
    emphasis: "secondary",
    keys: ["MIN", "P5", "P25", "P75", "MAX"],
  },
] as const satisfies readonly {
  id: string;
  title: string;
  accent: string;
  emphasis: "primary" | "secondary";
  keys: readonly StatisticKey[];
}[];

export function build_statistic_groups(metrics: readonly StatisticMetric[]) {
  const metrics_by_key = new Map(metrics.map((metric) => [metric.key, metric]));
  let animation_index = 0;
  return DISTRIBUTION_STATISTIC_GROUPS.map((group) => ({
    ...group,
    animation_index: animation_index++,
    // The view model contains every statistic; grouping only changes presentation.
    metrics: group.keys.map((key) => ({
      ...metrics_by_key.get(key)!,
      description: get_statistic_description(key),
      value_size: STATISTIC_VIEW_CONFIG[key].value_size,
      animation_index: animation_index++,
    })),
  }));
}

export const TERMINATION_REASON_VIEW_CONFIG = {
  segment_colors: [
    "var(--color-pk-a)",
    "var(--color-pk-b)",
    "var(--color-pk-c)",
    "var(--color-pk-d)",
    "var(--color-pk-e)",
    "var(--color-pk-f)",
    "var(--color-pk-g)",
    "var(--color-pk-h)",
  ],
} as const;
