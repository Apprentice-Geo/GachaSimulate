import { normalize_input } from "./normalize_input";
import { validate_input } from "./validate_input";
import type { NormalizedVisualizeInputData } from "../types/visualize_input";

const INPUT_ENDPOINT = "/__visualize_input";

export async function load_input_from_value(
  value: unknown,
): Promise<NormalizedVisualizeInputData> {
  const validation_result = validate_input(value);
  if (!validation_result.valid || !validation_result.data) {
    throw new Error(validation_result.errors.join("\n"));
  }

  return normalize_input(validation_result.data);
}

export async function load_input_from_file(
  file: File,
): Promise<NormalizedVisualizeInputData> {
  const text = await file.text();
  const parsed = JSON.parse(text) as unknown;
  return load_input_from_value(parsed);
}

export async function load_input_from_project_path(
  input_path: string,
): Promise<NormalizedVisualizeInputData> {
  const response = await fetch(
    `${INPUT_ENDPOINT}?path=${encodeURIComponent(input_path)}`,
  );
  const parsed = (await response.json()) as unknown;

  if (!response.ok) {
    const error =
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string"
        ? parsed.error
        : `读取 input 失败：HTTP ${response.status}`;
    throw new Error(error);
  }

  return load_input_from_value(parsed);
}

export function get_input_path_from_url(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("input");
}
