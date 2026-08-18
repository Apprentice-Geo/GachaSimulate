export interface DisplayConfig {
  display_version: 1;
  title: string;
  target: string;
  result_item_name: string;
  note: string;
  price: string;
  unit: string;
}

export const DISPLAY_CONFIG_KEYS = [
  "display_version",
  "title",
  "target",
  "result_item_name",
  "note",
  "price",
  "unit",
] as const;
