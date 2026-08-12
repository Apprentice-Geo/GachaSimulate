import type { ConfigItem } from "../shared/installed_config";

export function default_result_item(items: ConfigItem[]): string {
  return items.some(({ id }) => id === "draw_count")
    ? "draw_count"
    : (items[0]?.id ?? "");
}

export function selected_result_item(
  input: string,
  items: ConfigItem[],
): string | null {
  const id = input.trim();
  return items.some((item) => item.id === id) ? id : null;
}
