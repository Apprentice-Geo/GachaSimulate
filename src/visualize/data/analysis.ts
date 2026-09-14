import Ajv2020 from "ajv/dist/2020";
import schema from "../../../docs/schemas/analysis.schema.json";
import type { Analysis } from "../types/analysis";

const validate_schema = new Ajv2020({ allErrors: true }).compile(schema);

export function validate_analysis(value: unknown): Analysis {
  if (!validate_schema(value)) {
    throw new Error(
      (validate_schema.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; "),
    );
  }
  const analysis = value as unknown as Analysis;
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
