import type { DisplayConfig } from "../types/display_config";

const DISPLAY_CONFIG_KEYS = [
  "display_version",
  "title",
  "target",
  "result_item_name",
  "note",
  "subtitle",
  "result_item_unit",
] as const;

export function validate_display_config(value: unknown): DisplayConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("/ must be object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== DISPLAY_CONFIG_KEYS.length) {
    throw new Error("/ must contain exact DisplayConfig v2 fields");
  }
  for (const key of DISPLAY_CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`/ must have required property '${key}'`);
    }
  }
  if (record.display_version !== 2) {
    throw new Error("/display_version must be equal to constant 2");
  }
  if (typeof record.title !== "string") {
    throw new Error("/title must be string");
  }
  if (typeof record.target !== "string") {
    throw new Error("/target must be string");
  }
  if (
    typeof record.result_item_name !== "string" ||
    record.result_item_name.length < 1
  ) {
    throw new Error("/result_item_name must be a non-empty string");
  }
  if (typeof record.note !== "string") {
    throw new Error("/note must be string");
  }
  if (typeof record.subtitle !== "string") {
    throw new Error("/subtitle must be string");
  }
  if (typeof record.result_item_unit !== "string") {
    throw new Error("/result_item_unit must be string");
  }
  return record as unknown as DisplayConfig;
}
