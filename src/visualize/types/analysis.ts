import type { TerminationReasonInput } from "./visualize_input";

export interface AnalysisV2 {
  analysis_version: 2;
  result_item: { id: string; name: string };
  totals: { runs: string; result: string };
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
