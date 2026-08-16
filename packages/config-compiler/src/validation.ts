import { parseDocument } from "yaml";
import type { ConfigItem } from "./types.js";

export const YAML_TEXT_LIMIT = 1024 * 1024;
export const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class CompilerError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "CompilerError";
  }
}

export function fail(path: string, message: string): never {
  throw new CompilerError(path, message);
}

export function map(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(path, "must be a mapping");
  return value as Record<string, unknown>;
}

export function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be a list");
  return value;
}

export function integer(
  value: unknown,
  path: string,
  positive = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (positive ? 1 : 0)
  )
    fail(
      path,
      `must be a ${positive ? "positive" : "non-negative"} safe integer`,
    );
  return value;
}

export function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    fail(path, "must be a finite positive number");
  return value;
}

export function keys(
  value: Record<string, unknown>,
  path: string,
  allowed: string[],
) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${path}.${key}`, "unsupported field");
}

export function actions(value: unknown, path: string): string[] {
  if (value == null) return [];
  const result = typeof value === "string" ? [value] : list(value, path);
  result.forEach((item, index) => {
    if (typeof item !== "string")
      fail(`${path}[${index}]`, "must be an action string");
  });
  return result as string[];
}

export function parse_yaml(
  text: string,
  name: string,
): Record<string, unknown> {
  if (new TextEncoder().encode(text).byteLength > YAML_TEXT_LIMIT)
    fail(name, "must not exceed 1 MiB");
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length)
    fail(name, document.errors[0].message.replace(/\n.*/s, ""));
  try {
    return map(document.toJS({ maxAliasCount: 0 }), name);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

export function config_items(value: unknown): ConfigItem[] {
  const rawItems = list(value, "config.items");
  if (!rawItems.length) fail("config.items", "must be non-empty");
  const itemIds = new Set<string>();
  return rawItems.map((entry, index) => {
    let id: string, name: string;
    if (typeof entry === "string") id = name = entry;
    else {
      const single = map(entry, `config.items[${index}]`);
      if (Object.keys(single).length !== 1)
        fail(`config.items[${index}]`, "must be a single-key mapping");
      [id, name] = Object.entries(single)[0] as [string, string];
    }
    if (!ID.test(id)) fail(`config.items[${index}]`, "invalid item id");
    if (itemIds.has(id))
      fail(`config.items[${index}]`, `duplicate item id: ${id}`);
    if (typeof name !== "string" || !name)
      fail(`config.items[${index}]`, "name must be a non-empty string");
    itemIds.add(id);
    return { id, name };
  });
}

export function read_config_items(config_text: string): ConfigItem[] {
  return config_items(parse_yaml(config_text, "config").items);
}
