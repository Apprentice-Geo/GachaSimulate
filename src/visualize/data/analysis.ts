import Ajv2020 from "ajv/dist/2020";
import schema from "../../../docs/schemas/analysis_v1.schema.json";
import type { AnalysisV1 } from "../types/analysis";
import type { VisualizeInput } from "../types/visualize_input";
import { validate_input } from "./validate_input";

const validate_schema = new Ajv2020({ allErrors: true }).compile(schema);
const INTEGER_KEYS = [
  "P5",
  "P25",
  "P50",
  "P75",
  "P95",
  "MIN",
  "MEAN",
  "MAX",
] as const;

export function validate_analysis(value: unknown): AnalysisV1 {
  if (!validate_schema(value)) {
    throw new Error(
      (validate_schema.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; "),
    );
  }
  const analysis = value as unknown as AnalysisV1;
  if (
    analysis.values.length !== analysis.cumulative.length ||
    analysis.cumulative.at(-1) !== 1 ||
    analysis.values.some((entry, index) =>
      index ? BigInt(entry) <= BigInt(analysis.values[index - 1]) : false,
    ) ||
    analysis.cumulative.some((entry, index) =>
      index ? entry <= analysis.cumulative[index - 1] : false,
    ) ||
    analysis.termination_reason.reduce(
      (sum, entry) => sum + entry.proportion,
      0,
    ) !== 100
  ) {
    throw new Error("analysis arrays or proportions are inconsistent");
  }
  return analysis;
}

function safe_non_negative(value: string, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${name} is outside the supported visualization range`);
  }
  return result;
}

export function analysis_to_visualize(
  value: unknown,
  mtime_ms: number,
): VisualizeInput {
  const analysis = validate_analysis(value);
  const total_text =
    analysis.metric === "draw" ? analysis.totals.draw : analysis.totals.cost;
  if (total_text == null || !Number.isFinite(mtime_ms)) {
    throw new Error("analysis metric total or GSR mtime is invalid");
  }
  const statistic = Object.fromEntries(
    INTEGER_KEYS.map((key) => [
      key,
      safe_non_negative(analysis.statistic[key], `statistic.${key}`),
    ]),
  ) as unknown as VisualizeInput["statistic"];
  statistic.MEAN_LEVEL = analysis.statistic.MEAN_LEVEL;
  const input: VisualizeInput = {
    title: "模拟结果",
    target: "未设置",
    metric: analysis.metric,
    total: safe_non_negative(total_text, "total"),
    note: "MEAN 受极端值影响，P50 更接近“典型体验”，P95 更适合衡量高风险预算。MIN、MAX 受模拟次数影响，不代表理论极限。",
    statistic,
    termination_reason: analysis.termination_reason,
    timestamp: Math.trunc(mtime_ms / 1000),
    values: analysis.values.map((entry, index) =>
      safe_non_negative(entry, `values[${index}]`),
    ),
    cumulative: analysis.cumulative,
    price: "",
    unit: "",
  };
  const validated = validate_input(input);
  if (!validated.valid || !validated.data) {
    throw new Error(validated.errors.join("; "));
  }
  return validated.data;
}
