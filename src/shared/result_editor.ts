import type {
  VisualizeInput,
  VisualizeMetric,
} from "../visualize/types/visualize_input";

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
  metric: VisualizeMetric;
  fields: DisplayFields;
  sidecar_path: string;
};
