import type { StatisticKey } from "../types/visualize_input";

export type DistributionStatisticKey = StatisticKey;

interface StatisticViewConfig {
  label: string;
  description: string;
}

export const STATISTIC_VIEW_CONFIG: Record<StatisticKey, StatisticViewConfig> =
  {
    P5: {
      label: "P5",
      description: "5% 模拟在此抽数内达成",
    },
    P25: {
      label: "P25",
      description: "25% 模拟在此抽数内达成",
    },
    P50: {
      label: "P50",
      description: "50% 模拟在此抽数内达成",
    },
    P75: {
      label: "P75",
      description: "75% 模拟在此抽数内达成",
    },
    P95: {
      label: "P95",
      description: "95% 模拟在此抽数内达成",
    },
    MEAN: {
      label: "MEAN",
      description: "所有模拟结果的平均抽数",
    },
    MIN: {
      label: "MIN",
      description: "本轮模拟达成抽数最小值",
    },
    MAX: {
      label: "MAX",
      description: "本轮模拟达成抽数最大值",
    },
  };

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

export const DISTRIBUTION_STATISTIC_GROUPS = [
  {
    title: "低抽数区间",
    keys: ["MIN", "P5", "P25"],
  },
  {
    title: "中抽数区间",
    keys: ["P50", "MEAN"],
  },
  {
    title: "高抽数区间",
    keys: ["P75", "P95", "MAX"],
  },
] as const satisfies readonly {
  title: string;
  keys: readonly DistributionStatisticKey[];
}[];

export const TERMINATION_REASON_VIEW_CONFIG = {
  segment_colors: ["var(--color-pk-a)", "var(--color-pk-b)"],
} as const;
