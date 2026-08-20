import type { StatisticKey } from "../types/cdf";

export type DistributionStatisticKey = StatisticKey;

interface StatisticViewConfig {
  label: string;
}

export const STATISTIC_VIEW_CONFIG: Record<StatisticKey, StatisticViewConfig> =
  {
    P5: {
      label: "P5",
    },
    P25: {
      label: "P25",
    },
    P50: {
      label: "P50",
    },
    P75: {
      label: "P75",
    },
    P95: {
      label: "P95",
    },
    MEAN: {
      label: "MEAN",
    },
    MIN: {
      label: "MIN",
    },
    MAX: {
      label: "MAX",
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

const DISTRIBUTION_GROUP_KEYS = [
  ["MIN", "P5", "P25"],
  ["P50", "MEAN"],
  ["P75", "P95", "MAX"],
] as const satisfies readonly (readonly DistributionStatisticKey[])[];

export function get_distribution_statistic_groups(): {
  title: string;
  keys: readonly DistributionStatisticKey[];
}[] {
  return ["偏低结果", "典型结果", "偏高结果"].map((title, index) => ({
    title,
    keys: DISTRIBUTION_GROUP_KEYS[index],
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
