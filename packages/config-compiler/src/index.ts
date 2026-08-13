import { parseDocument } from "yaml";

const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MANIFEST_ID = /^[A-Za-z0-9_-]+$/;
const ACTION = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\+=|-=|=)\s*(\d+)$/;
const CHECK = /^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|==|!=|>|<)\s*(\d+)$/;

export class CompilerError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "CompilerError";
  }
}

export type ActionRange = { begin: number; count: number };
export type CompiledProgram = { ir: Record<string, unknown> };
export type ConfigItem = { id: string; name: string };
export type ConfigTermination = { file: string; name: string };
export type ConfigManifest = {
  id: string;
  name: string;
  description: string;
  terminations: ConfigTermination[];
  metadata?: unknown;
};

function fail(path: string, message: string): never {
  throw new CompilerError(path, message);
}
function map(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(path, "must be a mapping");
  return value as Record<string, unknown>;
}
function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be a list");
  return value;
}
function integer(value: unknown, path: string, positive = false): number {
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
function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    fail(path, "must be a finite positive number");
  return value;
}
function keys(value: Record<string, unknown>, path: string, allowed: string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${path}.${key}`, "unsupported field");
}
function actions(value: unknown, path: string): string[] {
  if (value == null) return [];
  const result = typeof value === "string" ? [value] : list(value, path);
  result.forEach((item, index) => {
    if (typeof item !== "string")
      fail(`${path}[${index}]`, "must be an action string");
  });
  return result as string[];
}

function parse_yaml(text: string, name: string): Record<string, unknown> {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length)
    fail(name, document.errors[0].message.replace(/\n.*/s, ""));
  return map(document.toJS(), name);
}

function config_items(value: unknown): ConfigItem[] {
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

function config_manifest(value: unknown): ConfigManifest {
  const manifest = map(value, "manifest");
  keys(manifest, "manifest", [
    "id",
    "name",
    "description",
    "terminations",
    "metadata",
  ]);
  if (typeof manifest.id !== "string" || !MANIFEST_ID.test(manifest.id))
    fail("manifest.id", "must be a valid config id");
  if (typeof manifest.name !== "string" || !manifest.name.trim())
    fail("manifest.name", "must be a non-empty string");
  if (typeof manifest.description !== "string")
    fail("manifest.description", "must be a string");
  const terminations = list(manifest.terminations, "manifest.terminations");
  if (!terminations.length) fail("manifest.terminations", "must be non-empty");
  const parsedTerminations = terminations.map((raw, index) => {
    const path = `manifest.terminations[${index}]`;
    const termination = map(raw, path);
    keys(termination, path, ["file", "name"]);
    if (
      typeof termination.file !== "string" ||
      !termination.file ||
      termination.file.includes("/") ||
      termination.file.includes("\\")
    )
      fail(`${path}.file`, "must be a non-empty file name");
    if (typeof termination.name !== "string" || !termination.name.trim())
      fail(`${path}.name`, "must be a non-empty string");
    return { file: termination.file, name: termination.name };
  });
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    terminations: parsedTerminations,
    ...(Object.hasOwn(manifest, "metadata")
      ? { metadata: manifest.metadata }
      : {}),
  };
}

export function read_config_manifest(manifest_text: string): ConfigManifest {
  return config_manifest(parse_yaml(manifest_text, "manifest"));
}

/** Compiles the v2 YAML contract to a JSON-serializable, flat arena IR. */
export function compile_yaml(
  config_text: string,
  termination_text: string,
  manifest_text: string,
  result_item: string,
): CompiledProgram {
  return compile(
    parse_yaml(config_text, "config"),
    parse_yaml(termination_text, "termination"),
    parse_yaml(manifest_text, "manifest"),
    result_item,
  );
}

export function compile(
  configValue: unknown,
  terminationValue: unknown,
  manifestValue: unknown,
  result_item: string,
): CompiledProgram {
  const config = map(configValue, "config");
  const termination = map(terminationValue, "termination");
  config_manifest(manifestValue);
  keys(config, "config", [
    "schema_version",
    "items",
    "pools",
    "initial",
    "every_draw",
    "rules",
    "item_resolve",
  ]);
  if (config.schema_version !== 2) fail("config.schema_version", "must be 2");
  keys(termination, "termination", ["retained_items", "termination_rule"]);
  if ("schema_version" in termination)
    fail("termination.schema_version", "must inherit config schema_version");
  const strings: string[] = [];
  const stringId = (value: string) => {
    const found = strings.indexOf(value);
    if (found >= 0) return found;
    strings.push(value);
    return strings.length - 1;
  };
  const itemIds = new Map<string, number>();
  const items: { id: number; name: number }[] = [];
  config_items(config.items).forEach(({ id, name }) => {
    itemIds.set(id, items.length);
    items.push({ id: stringId(id), name: stringId(name) });
  });
  const pools: { id: number; entries: ActionRange }[] = [];
  const poolIds = new Map<string, number>();
  const pool_entries: { threshold: number; actions: ActionRange }[] = [];
  const actionArena: Record<string, unknown>[] = [];
  const range = (values: string[], path: string): ActionRange => {
    const begin = actionArena.length;
    values.forEach((value, i) =>
      actionArena.push(action(value, `${path}[${i}]`)),
    );
    return { begin, count: actionArena.length - begin };
  };
  const action = (value: string, path: string): Record<string, unknown> => {
    const item = ACTION.exec(value.trim());
    if (item) {
      const index = itemIds.get(item[1]);
      if (index == null) fail(path, `unknown item id: ${item[1]}`);
      const amount = integer(Number(item[3]), path, item[2] !== "=");
      return {
        kind:
          item[2] === "+="
            ? "add_item"
            : item[2] === "-="
              ? "reduce_item"
              : "set_item",
        item: index,
        amount,
      };
    }
    const [command, ...rest] = value.trim().split(/\s+/);
    const target = rest.join(" ");
    if (command === "draw" || command === "change") {
      const index = poolIds.get(target);
      if (index == null) fail(path, `unknown pool id: ${target}`);
      return { kind: command, pool: index };
    }
    if (command === "terminate" && target)
      return { kind: "terminate", reason: stringId(target) };
    fail(path, `unsupported action: ${value}`);
  };
  const rawPools = list(config.pools, "config.pools");
  if (!rawPools.length) fail("config.pools", "must be non-empty");
  rawPools.forEach((entry, index) => {
    const single = map(entry, `config.pools[${index}]`);
    if (Object.keys(single).length !== 1)
      fail(`config.pools[${index}]`, "must be a single-key mapping");
    const id = Object.keys(single)[0];
    if (!ID.test(id) || poolIds.has(id))
      fail(`config.pools[${index}]`, "invalid or duplicate pool id");
    poolIds.set(id, index);
    pools.push({ id: stringId(id), entries: { begin: 0, count: 0 } });
  });
  rawPools.forEach((entry, index) => {
    const [id, rawEntries] = Object.entries(
      map(entry, `config.pools[${index}]`),
    )[0];
    const entries = list(rawEntries, `config.pools[${index}].${id}`);
    if (!entries.length)
      fail(`config.pools[${index}].${id}`, "must be non-empty");
    const begin = pool_entries.length;
    let total = 0;
    let weighted: boolean | undefined;
    entries.forEach((raw, entryIndex) => {
      const path = `config.pools[${index}].${id}[${entryIndex}]`;
      const entry = map(raw, path);
      keys(entry, path, ["probability", "weight", "actions"]);
      const isWeight = "weight" in entry;
      if ("probability" in entry === isWeight)
        fail(path, "must contain exactly one of probability or weight");
      if (weighted != null && weighted !== isWeight)
        fail(path, "cannot mix probability and weight");
      weighted = isWeight;
      total += number(
        entry[isWeight ? "weight" : "probability"],
        `${path}.${isWeight ? "weight" : "probability"}`,
      );
      pool_entries.push({
        threshold: total,
        actions: range(
          actions(entry.actions, `${path}.actions`),
          `${path}.actions`,
        ),
      });
    });
    if (!weighted && Math.abs(total - 1) > 1e-9)
      fail(`config.pools[${index}].${id}`, "probability sum must be 1");
    const slice = pool_entries.slice(begin);
    slice.forEach((entry) => {
      entry.threshold = weighted ? entry.threshold / total : entry.threshold;
    });
    slice.at(-1)!.threshold = 1;
    pools[index].entries = { begin, count: slice.length };
  });
  const conditions: Record<string, unknown>[] = [];
  const condition_children: number[] = [];
  const condition = (raw: unknown, path: string): number => {
    const node = map(raw, path);
    const own = range(
      actions(node.actions, `${path}.actions`),
      `${path}.actions`,
    );
    if ("check" in node) {
      keys(node, path, ["check", "actions"]);
      if (typeof node.check !== "string")
        fail(`${path}.check`, "must be a condition string");
      const match = CHECK.exec(node.check.trim());
      if (!match) fail(`${path}.check`, "unsupported condition");
      const item = itemIds.get(match[1]);
      if (item == null) fail(`${path}.check`, `unknown item id: ${match[1]}`);
      return (
        conditions.push({
          kind: "check",
          item,
          op: match[2],
          value: integer(Number(match[3]), `${path}.check`),
          actions: own,
        }) - 1
      );
    }
    keys(node, path, ["op", "children", "actions"]);
    if (!["AND", "OR", "&&", "||"].includes(node.op as string))
      fail(`${path}.op`, "unsupported logic op");
    const children = list(node.children, `${path}.children`);
    if (!children.length) fail(`${path}.children`, "must be non-empty");
    const begin = condition_children.length;
    children.forEach((child, index) =>
      condition_children.push(condition(child, `${path}.children[${index}]`)),
    );
    return (
      conditions.push({
        kind: "logic",
        op: node.op === "&&" ? "AND" : node.op === "||" ? "OR" : node.op,
        children: { begin, count: children.length },
        actions: own,
      }) - 1
    );
  };
  const resolve = Array.from({ length: items.length }, () => ({
    retain: 0,
    reduce_per_batch: 0,
    actions: { begin: 0, count: 0 },
  }));
  const resolves =
    config.item_resolve == null
      ? []
      : list(config.item_resolve, "config.item_resolve");
  resolves.forEach((raw, index) => {
    const path = `config.item_resolve[${index}]`;
    const value = map(raw, path);
    keys(value, path, ["item", "retain", "actions"]);
    const item =
      typeof value.item === "string" ? itemIds.get(value.item) : undefined;
    if (item == null || resolve[item].actions.count)
      fail(`${path}.item`, "unknown or duplicate resolved item");
    const values = actions(value.actions, `${path}.actions`);
    const reduce = values
      .map((entry) => ACTION.exec(entry.trim()))
      .filter(
        (match): match is RegExpExecArray =>
          match != null && match[1] === value.item && match[2] === "-=",
      );
    const reducesOtherItem = values.some((entry) => {
      const match = ACTION.exec(entry.trim());
      return match?.[2] === "-=" && match[1] !== value.item;
    });
    if (!values.length || reduce.length !== 1 || reducesOtherItem)
      fail(
        `${path}.actions`,
        "must contain exactly one reduce action for the resolved item and no other item reductions",
      );
    resolve[item] = {
      retain: integer(value.retain, `${path}.retain`),
      reduce_per_batch: integer(Number(reduce[0][3]), `${path}.actions`, true),
      actions: range(values, `${path}.actions`),
    };
  });
  const retained = list(
    termination.retained_items,
    "termination.retained_items",
  );
  const retainedIds = new Set<string>();
  retained.forEach((raw, index) => {
    const value = map(raw, `termination.retained_items[${index}]`);
    if (Object.keys(value).length !== 1)
      fail(
        `termination.retained_items[${index}]`,
        "must be a single-key mapping",
      );
    const [id, count] = Object.entries(value)[0];
    const item = itemIds.get(id);
    if (item == null || retainedIds.has(id))
      fail(
        `termination.retained_items[${index}]`,
        "unknown or duplicate retained item",
      );
    retainedIds.add(id);
    resolve[item].retain = Math.max(
      resolve[item].retain,
      integer(count, `termination.retained_items[${index}].${id}`),
    );
  });
  const everyPathHasAction = (raw: unknown, path: string): boolean => {
    const node = map(raw, path);
    if (actions(node.actions, `${path}.actions`).length) return true;
    if ("check" in node) return false;
    const children = list(node.children, `${path}.children`);
    return ["OR", "||"].includes(node.op as string)
      ? children.every((child, index) =>
          everyPathHasAction(child, `${path}.children[${index}]`),
        )
      : children.some((child, index) =>
          everyPathHasAction(child, `${path}.children[${index}]`),
        );
  };
  const conditionHasAction = (raw: unknown, path: string): boolean => {
    const node = map(raw, path);
    if (actions(node.actions, `${path}.actions`).length) return true;
    if ("check" in node) return false;
    return list(node.children, `${path}.children`).some((child, index) =>
      conditionHasAction(child, `${path}.children[${index}]`),
    );
  };
  const rules: Record<string, unknown>[] = [];
  const ruleIds = new Set<string>();
  const rawRules =
    config.rules == null ? [] : list(config.rules, "config.rules");
  rawRules.forEach((raw, index) => {
    const value = map(raw, `config.rules[${index}]`);
    if (Object.keys(value).length !== 1)
      fail(`config.rules[${index}]`, "must be a single-key mapping");
    const [id, body] = Object.entries(value)[0];
    if (!ID.test(id)) fail(`config.rules[${index}]`, "invalid rule id");
    if (ruleIds.has(id))
      fail(`config.rules[${index}]`, `duplicate rule id: ${id}`);
    ruleIds.add(id);
    const rule = map(body, `config.rules[${index}].${id}`);
    keys(rule, `config.rules[${index}].${id}`, ["mode", "condition"]);
    const mode = rule.mode ?? "once";
    if (!["once", "per_draw", "repeat"].includes(mode as string))
      fail(`config.rules[${index}].${id}.mode`, "unsupported mode");
    if (
      !conditionHasAction(
        rule.condition,
        `config.rules[${index}].${id}.condition`,
      )
    )
      fail(
        `config.rules[${index}].${id}.condition`,
        "must contain at least one action",
      );
    if (
      mode === "repeat" &&
      !everyPathHasAction(
        rule.condition,
        `config.rules[${index}].${id}.condition`,
      )
    )
      fail(
        `config.rules[${index}].${id}.condition`,
        "every repeat path must contain at least one action",
      );
    rules.push({
      id: stringId(id),
      mode,
      condition: condition(
        rule.condition,
        `config.rules[${index}].${id}.condition`,
      ),
    });
  });
  const everyPathTerminates = (raw: unknown, path: string): boolean => {
    const node = map(raw, path);
    if (
      actions(node.actions, `${path}.actions`).some((entry) =>
        entry.trim().startsWith("terminate "),
      )
    )
      return true;
    if ("check" in node) return false;
    const children = list(node.children, `${path}.children`);
    return ["OR", "||"].includes(node.op as string)
      ? children.every((child, index) =>
          everyPathTerminates(child, `${path}.children[${index}]`),
        )
      : children.some((child, index) =>
          everyPathTerminates(child, `${path}.children[${index}]`),
        );
  };
  const termRule = map(
    termination.termination_rule,
    "termination.termination_rule",
  );
  keys(termRule, "termination.termination_rule", ["condition"]);
  if (
    !everyPathTerminates(
      termRule.condition,
      "termination.termination_rule.condition",
    )
  )
    fail(
      "termination.termination_rule.condition",
      "every termination path must contain a terminate action",
    );
  if (typeof result_item !== "string" || !ID.test(result_item))
    fail("result_item", "must be an item id");
  const resultItem = itemIds.get(result_item);
  if (resultItem == null)
    fail("result_item", `unknown item id: ${result_item}`);
  return {
    ir: {
      ir_version: 2,
      result_item: resultItem,
      items,
      strings,
      actions: actionArena,
      pools,
      pool_entries,
      rules,
      condition_nodes: conditions,
      condition_children,
      item_resolve: resolve,
      initial: range(
        actions(config.initial, "config.initial"),
        "config.initial",
      ),
      every_draw: range(
        actions(config.every_draw, "config.every_draw"),
        "config.every_draw",
      ),
      termination: range([], "termination"),
      termination_condition: condition(
        termRule.condition,
        "termination.termination_rule.condition",
      ),
    },
  };
}
