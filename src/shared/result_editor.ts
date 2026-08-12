import type { VisualizeInput } from "../visualize/types/visualize_input";

export const DISPLAY_FIELD_KEYS = [
  "title",
  "target",
  "note",
  "price",
  "unit",
] as const;

export type DisplayFields = Pick<
  VisualizeInput,
  (typeof DISPLAY_FIELD_KEYS)[number]
>;

export type ResultEditorState = {
  path: string;
  filename: string;
  fields: DisplayFields;
  input: VisualizeInput;
  sidecar_path: string;
};
