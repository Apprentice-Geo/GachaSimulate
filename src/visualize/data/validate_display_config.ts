import Ajv2020 from "ajv/dist/2020";
import schema from "../../../docs/schemas/display_config.schema.json";
import type { DisplayConfig } from "../types/display_config";

const validate_schema = new Ajv2020({ allErrors: true }).compile(schema);

export function validate_display_config(value: unknown): DisplayConfig {
  if (!validate_schema(value)) {
    throw new Error(
      (validate_schema.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; "),
    );
  }
  return value as unknown as DisplayConfig;
}
