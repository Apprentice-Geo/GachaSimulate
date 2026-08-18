import Ajv2020 from "ajv/dist/2020";
import schema from "../../../docs/schemas/analysis_v2.schema.json";
import type { AnalysisV2 } from "../types/analysis";

const validate_schema = new Ajv2020({ allErrors: true }).compile(schema);

export function validate_analysis(value: unknown): AnalysisV2 {
  if (!validate_schema(value)) {
    throw new Error(
      (validate_schema.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; "),
    );
  }
  const analysis = value as unknown as AnalysisV2;
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
