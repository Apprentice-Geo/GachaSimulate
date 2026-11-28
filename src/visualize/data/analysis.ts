import type { Analysis } from "../types/analysis";
import type { StatisticKey } from "../types/cdf";

export const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const MAX_U64_TEXT = "18446744073709551615";

const ANALYSIS_KEYS = [
  "result_item",
  "totals",
  "values",
  "cumulative",
  "statistic",
  "termination_reason",
] as const;

const RESULT_ITEM_KEYS = ["id", "name"] as const;
const TOTALS_KEYS = ["runs", "result"] as const;
const TERMINATION_REASON_KEYS = ["reason", "proportion"] as const;
const STATISTIC_OBJECT_KEYS = [
  "P5",
  "P25",
  "P50",
  "P75",
  "P95",
  "MIN",
  "MEAN",
  "MEAN_LEVEL",
  "MAX",
] as const;

const STATISTIC_KEYS: readonly StatisticKey[] = [
  "P5",
  "P25",
  "P50",
  "P75",
  "P95",
  "MIN",
  "MEAN",
  "MAX",
];

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assert_exact_object(
  value: unknown,
  expected_keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== expected_keys.length) {
    throw new Error(`${label} must not have missing or additional properties`);
  }
  for (const key of expected_keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`${label} must have required property '${key}'`);
    }
  }
  return record;
}

export interface ParsedAnalysis {
  readonly analysis: Analysis;
  readonly runs: bigint;
  readonly total_result: bigint;
  readonly statistic: Readonly<Record<StatisticKey, bigint>>;
  readonly values: readonly bigint[];
}

const wire_parsed_handoff = new WeakMap<Analysis, ParsedAnalysis>();

export function register_wire_parsed_analysis(
  analysis: Analysis,
  parsed: ParsedAnalysis,
): void {
  wire_parsed_handoff.set(analysis, parsed);
}

export function consume_wire_parsed_analysis(
  analysis: Analysis,
): ParsedAnalysis | undefined {
  const parsed = wire_parsed_handoff.get(analysis);
  if (parsed !== undefined) {
    wire_parsed_handoff.delete(analysis);
  }
  return parsed;
}

export function parse_canonical_u64(value: string, label: string): bigint {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 20 ||
    !/^(?:0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new Error(`${label} must be a canonical unsigned integer string`);
  }
  if (value.length === 20 && value > MAX_U64_TEXT) {
    throw new Error(`${label} is outside the supported u64 range`);
  }
  return BigInt(value);
}

export function validate_and_parse_analysis(value: unknown): ParsedAnalysis {
  const root = assert_exact_object(value, ANALYSIS_KEYS, "/");

  const result_item = assert_exact_object(
    root.result_item,
    RESULT_ITEM_KEYS,
    "/result_item",
  );
  if (
    typeof result_item.id !== "string" ||
    !IDENTIFIER_PATTERN.test(result_item.id)
  ) {
    throw new Error("/result_item/id must match identifier pattern");
  }
  if (typeof result_item.name !== "string" || result_item.name.length < 1) {
    throw new Error("/result_item/name must be a non-empty string");
  }

  const totals = assert_exact_object(root.totals, TOTALS_KEYS, "/totals");
  const runs = parse_canonical_u64(totals.runs as string, "totals.runs");
  if (runs < 1n) {
    throw new Error("totals.runs must be positive");
  }
  const total_result = parse_canonical_u64(
    totals.result as string,
    "totals.result",
  );

  const statistic_obj = assert_exact_object(
    root.statistic,
    STATISTIC_OBJECT_KEYS,
    "/statistic",
  );
  if (
    typeof statistic_obj.MEAN_LEVEL !== "number" ||
    !Number.isFinite(statistic_obj.MEAN_LEVEL) ||
    statistic_obj.MEAN_LEVEL < 0 ||
    statistic_obj.MEAN_LEVEL > 1
  ) {
    throw new Error("/statistic/MEAN_LEVEL must be a number in [0, 1]");
  }
  const statistic = {} as Record<StatisticKey, bigint>;
  for (const key of STATISTIC_KEYS) {
    statistic[key] = parse_canonical_u64(
      statistic_obj[key] as string,
      `statistic.${key}`,
    );
  }

  if (!Array.isArray(root.values) || !Array.isArray(root.cumulative)) {
    throw new Error("/values and /cumulative must be arrays");
  }
  const count = root.values.length;
  if (count === 0 || count !== root.cumulative.length) {
    throw new Error("analysis arrays or proportions are inconsistent");
  }

  const parsed_values = new Array<bigint>(count);
  let prev_value = 0n;
  let prev_cumulative = 0;
  for (let i = 0; i < count; i += 1) {
    const draw = parse_canonical_u64(root.values[i] as string, `values[${i}]`);
    const cumulative = root.cumulative[i];
    if (
      typeof cumulative !== "number" ||
      !Number.isFinite(cumulative) ||
      cumulative <= 0 ||
      cumulative > 1
    ) {
      throw new Error(`/cumulative/${i} must be a number in (0, 1]`);
    }
    if (i > 0 && (draw <= prev_value || cumulative <= prev_cumulative)) {
      throw new Error("analysis arrays or proportions are inconsistent");
    }
    parsed_values[i] = draw;
    prev_value = draw;
    prev_cumulative = cumulative;
  }
  if (prev_cumulative !== 1) {
    throw new Error("analysis arrays or proportions are inconsistent");
  }

  if (!Array.isArray(root.termination_reason)) {
    throw new Error("/termination_reason must be array");
  }
  let proportion_sum = 0;
  for (let i = 0; i < root.termination_reason.length; i += 1) {
    const entry = assert_exact_object(
      root.termination_reason[i],
      TERMINATION_REASON_KEYS,
      `/termination_reason/${i}`,
    );
    if (typeof entry.reason !== "string" || entry.reason.length < 1) {
      throw new Error(
        `/termination_reason/${i}/reason must be a non-empty string`,
      );
    }
    if (
      typeof entry.proportion !== "number" ||
      !Number.isInteger(entry.proportion) ||
      entry.proportion < 0 ||
      entry.proportion > 100
    ) {
      throw new Error(
        `/termination_reason/${i}/proportion must be an integer in [0, 100]`,
      );
    }
    proportion_sum += entry.proportion;
  }
  if (proportion_sum !== 100) {
    throw new Error("analysis arrays or proportions are inconsistent");
  }

  return {
    analysis: root as unknown as Analysis,
    runs,
    total_result,
    statistic,
    values: parsed_values,
  };
}

export function validate_analysis(value: unknown): Analysis {
  return validate_and_parse_analysis(value).analysis;
}
