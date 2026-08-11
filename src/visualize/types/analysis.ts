import type {
  TerminationReasonInput,
  VisualizeMetric,
} from "./visualize_input";

export interface AnalysisV1 {
  analysis_version: 1;
  metric: VisualizeMetric;
  totals: { runs: string; draw: string; cost: string | null };
  values: string[];
  cumulative: number[];
  statistic: {
    P5: string;
    P25: string;
    P50: string;
    P75: string;
    P95: string;
    MIN: string;
    MEAN: string;
    MEAN_LEVEL: number;
    MAX: string;
  };
  termination_reason: TerminationReasonInput[];
}
