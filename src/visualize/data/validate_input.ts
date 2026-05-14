import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import schema from '../../../docs/visualize_input.schema.json';
import type { VisualizeInput } from '../types/visualize_input';

export interface ValidationResult {
  valid: boolean;
  data?: VisualizeInput;
  errors: string[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validate_schema = ajv.compile(schema);

function format_schema_errors(): string[] {
  return (validate_schema.errors ?? []).map((error) => {
    const path = error.instancePath || '/';
    return `${path} ${error.message ?? '格式不符合 schema'}`;
  });
}

function is_monotonic_non_decreasing(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value >= values[index - 1]);
}

function validate_business_rules(input: VisualizeInput): string[] {
  const errors: string[] = [];

  if (input.draws.length === 0) {
    errors.push('draws 不能为空。');
  }

  if (input.draws.length !== input.cumulative.length) {
    errors.push('draws 与 cumulative 长度必须一致。');
  }

  if (!is_monotonic_non_decreasing(input.draws)) {
    errors.push('draws 必须单调不减。');
  }

  if (!is_monotonic_non_decreasing(input.cumulative)) {
    errors.push('cumulative 必须单调不减。');
  }

  if (
    input.termination_reason.length < 1 ||
    input.termination_reason.length > 2
  ) {
    errors.push('termination_reason 至少 1 项，至多 2 项。');
  }

  const proportion_total = input.termination_reason.reduce(
    (total, item) => total + item.proportion,
    0,
  );
  if (proportion_total !== 100) {
    errors.push('termination_reason 的 proportion 合计必须为 100。');
  }

  const stat = input.statistic;
  const ordered_values = [
    stat.MIN,
    stat.P5,
    stat.P25,
    stat.P50,
    stat.P75,
    stat.P95,
    stat.MAX,
  ];
  if (!is_monotonic_non_decreasing(ordered_values)) {
    errors.push('统计量必须满足 MIN <= P5 <= P25 <= P50 <= P75 <= P95 <= MAX。');
  }

  return errors;
}

export function validate_input(value: unknown): ValidationResult {
  const schema_valid = validate_schema(value);
  if (!schema_valid) {
    return {
      valid: false,
      errors: format_schema_errors(),
    };
  }

  const input = value as unknown as VisualizeInput;
  const business_errors = validate_business_rules(input);
  if (business_errors.length > 0) {
    return {
      valid: false,
      errors: business_errors,
    };
  }

  return {
    valid: true,
    data: input,
    errors: [],
  };
}
