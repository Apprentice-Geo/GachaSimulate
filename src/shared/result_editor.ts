import type { AnalysisV2 } from "../visualize/types/analysis";
import type { DisplayConfig } from "../visualize/types/display_config";

export const DISPLAY_FIELD_KEYS = [
  "title",
  "target",
  "result_item_name",
  "note",
  "price",
  "unit",
] as const;

export type DisplayFields = Pick<
  DisplayConfig,
  (typeof DISPLAY_FIELD_KEYS)[number]
>;

export type ResultEditorState = {
  path: string;
  filename: string;
  fields: DisplayFields;
  analysis: AnalysisV2;
  display: DisplayConfig;
  sidecar_path: string;
};
