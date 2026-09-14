import type { Analysis } from "../visualize/types/analysis";
import type { DisplayConfig } from "../visualize/types/display_config";

export const DISPLAY_FIELD_KEYS = [
  "title",
  "target",
  "result_item_name",
  "note",
  "subtitle",
  "result_item_unit",
] as const;

export type DisplayFields = Pick<
  DisplayConfig,
  (typeof DISPLAY_FIELD_KEYS)[number]
>;

export type ResultEditorState = {
  session_id: string;
  path: string;
  filename: string;
  fields: DisplayFields;
  analysis: Analysis;
  display: DisplayConfig;
  sidecar_path: string;
};

export type SaveResultFieldsRequest = {
  session_id: string;
  fields: DisplayFields;
};
