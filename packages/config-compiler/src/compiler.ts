import type { ActionRange, CompiledProgram } from "./types.js";
import {
  ID,
  actions,
  config_items,
  fail,
  integer,
  reject_unknown_keys,
  require_list,
  require_mapping,
  require_positive_number,
  parse_yaml,
} from "./validation.js";
import { validate_config_manifest } from "./manifest.js";

const ACTION = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\+=|-=|=)\s*(\d+)$/;
const CHECK = /^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|==|!=|>|<)\s*(\d+)$/;

type PreparedConfig = {
  apply_termination(
    terminationValue: unknown,
    result_item?: string,
    validate_only?: boolean,
  ): CompiledProgram | undefined;
};

export function prepare_config(configValue: unknown): PreparedConfig {
  const config = require_mapping(configValue, "config");
  reject_unknown_keys(config, "config", [
    "schema_version",
    "items",
    "pools",
    "initial",
    "every_draw",
    "rules",
    "item_resolve",
  ]);
  if (config.schema_version !== 2) fail("config.schema_version", "must be 2");
  let strings: string[] = [];
  const stringId = (value: string) => {
    const found = strings.indexOf(value);
    if (found >= 0) return found;
    strings.push(value);
    return strings.length - 1;
  };
  const itemIds = new Map<string, number>();
  const itemNames: string[] = [];
  const items: { id: number; name: number }[] = [];
  config_items(config.items).forEach(({ id, name }) => {
    itemIds.set(id, items.length);
    itemNames.push(id);
    items.push({ id: stringId(id), name: stringId(name) });
  });
  const pools: { id: number; entries: ActionRange }[] = [];
  const poolIds = new Map<string, number>();
  const pool_entries: { threshold: number; actions: ActionRange }[] = [];
  let actionArena: Record<string, unknown>[] = [];
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
  const rawPools = require_list(config.pools, "config.pools");
  if (!rawPools.length) fail("config.pools", "must be non-empty");
  rawPools.forEach((entry, index) => {
    const single = require_mapping(entry, `config.pools[${index}]`);
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
      require_mapping(entry, `config.pools[${index}]`),
    )[0];
    const entries = require_list(rawEntries, `config.pools[${index}].${id}`);
    if (!entries.length)
      fail(`config.pools[${index}].${id}`, "must be non-empty");
    const begin = pool_entries.length;
    let total = 0;
    let weighted: boolean | undefined;
    entries.forEach((raw, entryIndex) => {
      const path = `config.pools[${index}].${id}[${entryIndex}]`;
      const entry = require_mapping(raw, path);
      reject_unknown_keys(entry, path, ["probability", "weight", "actions"]);
      const isWeight = "weight" in entry;
      if ("probability" in entry === isWeight)
        fail(path, "must contain exactly one of probability or weight");
      if (weighted != null && weighted !== isWeight)
        fail(path, "cannot mix probability and weight");
      weighted = isWeight;
      total += require_positive_number(
        entry[isWeight ? "weight" : "probability"],
        `${path}.${isWeight ? "weight" : "probability"}`,
      );
      if (isWeight && !Number.isFinite(total))
        fail(`config.pools[${index}].${id}`, "weight sum must be finite");
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
  let conditions: Record<string, unknown>[] = [];
  let condition_children: number[] = [];
  const condition = (raw: unknown, path: string): number => {
    const node = require_mapping(raw, path);
    const own = range(
      actions(node.actions, `${path}.actions`),
      `${path}.actions`,
    );
    if ("check" in node) {
      reject_unknown_keys(node, path, ["check", "actions"]);
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
    reject_unknown_keys(node, path, ["op", "children", "actions"]);
    if (!["AND", "OR", "&&", "||"].includes(node.op as string))
      fail(`${path}.op`, "unsupported logic op");
    const children = require_list(node.children, `${path}.children`);
    if (!children.length) fail(`${path}.children`, "must be non-empty");
    const begin = condition_children.length;
    condition_children.push(...children.map(() => 0));
    children.forEach((child, index) => {
      condition_children[begin + index] = condition(
        child,
        `${path}.children[${index}]`,
      );
    });
    return (
      conditions.push({
        kind: "logic",
        op: node.op === "&&" ? "AND" : node.op === "||" ? "OR" : node.op,
        children: { begin, count: children.length },
        actions: own,
      }) - 1
    );
  };
  let resolve = Array.from({ length: items.length }, () => ({
    retain: 0,
    reduce_per_batch: 0,
    actions: { begin: 0, count: 0 },
  }));
  const resolves =
    config.item_resolve == null
      ? []
      : require_list(config.item_resolve, "config.item_resolve");
  resolves.forEach((raw, index) => {
    const path = `config.item_resolve[${index}]`;
    const value = require_mapping(raw, path);
    reject_unknown_keys(value, path, ["item", "retain", "actions"]);
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
  const nodeNames = [
    ...rawPools.map(
      (entry, index) =>
        `pool ${Object.keys(require_mapping(entry, `config.pools[${index}]`))[0]}`,
    ),
    ...itemNames.map((id) => `resolve ${id}`),
  ];
  const nodeRanges: ActionRange[][] = nodeNames.map(() => []);
  pools.forEach((pool, poolIndex) => {
    for (let i = 0; i < pool.entries.count; ++i)
      nodeRanges[poolIndex].push(pool_entries[pool.entries.begin + i].actions);
  });
  resolve.forEach((entry, item) => {
    if (entry.actions.count)
      nodeRanges[pools.length + item].push(entry.actions);
  });
  const edges = nodeNames.map(() => new Set<number>());
  const directWrites = nodeNames.map(() => new Set<number>());
  nodeRanges.forEach((ranges, node) => {
    ranges.forEach((actionRange) => {
      for (let i = 0; i < actionRange.count; ++i) {
        const entry = actionArena[actionRange.begin + i];
        if (entry.kind === "terminate") break;
        if (
          entry.kind === "add_item" ||
          entry.kind === "reduce_item" ||
          entry.kind === "set_item"
        ) {
          const item = entry.item as number;
          directWrites[node].add(item);
          if (entry.kind !== "reduce_item" && resolve[item].actions.count)
            edges[node].add(pools.length + item);
        } else if (entry.kind === "draw") {
          edges[node].add(entry.pool as number);
        }
      }
    });
  });
  const adjacency = edges.map((targets) => [...targets]);
  const colors = nodeNames.map(() => 0);
  const postorder: number[] = [];
  colors.forEach((color, node) => {
    if (color !== 0) return;
    colors[node] = 1;
    const stack = [{ node, targets: adjacency[node], next: 0 }];
    while (stack.length) {
      const frame = stack.at(-1)!;
      if (frame.next === frame.targets.length) {
        colors[frame.node] = 2;
        postorder.push(frame.node);
        stack.pop();
        continue;
      }
      const target = frame.targets[frame.next++];
      if (colors[target] === 1) {
        const cycle = [
          ...stack
            .slice(stack.findIndex((entry) => entry.node === target))
            .map((entry) => entry.node),
          target,
        ];
        fail(
          "config",
          `synchronous action cycle: ${cycle.map((id) => nodeNames[id]).join(" -> ")}`,
        );
      }
      if (colors[target] === 0) {
        colors[target] = 1;
        stack.push({ node: target, targets: adjacency[target], next: 0 });
      }
    }
  });
  const mayWriteCache = new Map<number, boolean[]>();
  const mayWrite = (item: number): boolean[] => {
    const cached = mayWriteCache.get(item);
    if (cached) return cached;
    const result = directWrites.map((items) => items.has(item));
    postorder.forEach((node) => {
      if (!result[node])
        result[node] = adjacency[node].some((target) => result[target]);
    });
    mayWriteCache.set(item, result);
    return result;
  };
  const repeatExits = (raw: unknown, path: string): void => {
    const node = require_mapping(raw, path);
    if (!("check" in node))
      fail(path, "repeat condition must be a single check");
    if (typeof node.check !== "string")
      fail(`${path}.check`, "must be a condition string");
    const check = CHECK.exec(node.check.trim());
    if (!check) fail(`${path}.check`, "unsupported condition");
    const checkedItem = itemIds.get(check[1]);
    if (checkedItem == null)
      fail(`${path}.check`, `unknown item id: ${check[1]}`);
    const nestedWrites = mayWrite(checkedItem);
    const checkedWrites: RegExpExecArray[] = [];
    let nestedWrite = false;
    for (const value of actions(node.actions, `${path}.actions`)) {
      const item = ACTION.exec(value.trim());
      if (item) {
        const target = itemIds.get(item[1]);
        if (target === checkedItem) checkedWrites.push(item);
        if (
          target != null &&
          item[2] !== "-=" &&
          resolve[target].actions.count &&
          nestedWrites[pools.length + target]
        )
          nestedWrite = true;
        continue;
      }
      const [command, target] = value.trim().split(/\s+/, 2);
      if (command === "terminate") return;
      const pool = command === "draw" ? poolIds.get(target) : undefined;
      if (pool != null && nestedWrites[pool]) nestedWrite = true;
    }
    if (nestedWrite)
      fail(
        `${path}.actions`,
        `nested pool or item resolver may write checked item: ${check[1]}`,
      );
    if (checkedWrites.length !== 1)
      fail(`${path}.actions`, "must write checked item exactly once");
    const write = checkedWrites[0];
    const amount = Number(write[3]);
    const compare = check[2];
    const value = Number(check[3]);
    const assignmentIsFalse =
      write[2] === "=" &&
      !(compare === "=="
        ? amount === value
        : compare === "!="
          ? amount !== value
          : compare === "<"
            ? amount < value
            : compare === "<="
              ? amount <= value
              : compare === ">"
                ? amount > value
                : amount >= value);
    const monotonicExit =
      amount > 0 &&
      (((compare === ">=" || compare === ">") && write[2] === "-=") ||
        ((compare === "<=" || compare === "<") && write[2] === "+=") ||
        (compare === "==" && (write[2] === "+=" || write[2] === "-=")));
    if (!assignmentIsFalse && !monotonicExit)
      fail(
        `${path}.actions`,
        "the checked item write does not make the condition false",
      );
  };
  const conditionHasAction = (raw: unknown, path: string): boolean => {
    const node = require_mapping(raw, path);
    if (actions(node.actions, `${path}.actions`).length) return true;
    if ("check" in node) return false;
    return require_list(node.children, `${path}.children`).some(
      (child, index) => conditionHasAction(child, `${path}.children[${index}]`),
    );
  };
  const rules: Record<string, unknown>[] = [];
  const ruleIds = new Set<string>();
  const rawRules =
    config.rules == null ? [] : require_list(config.rules, "config.rules");
  rawRules.forEach((raw, index) => {
    const value = require_mapping(raw, `config.rules[${index}]`);
    if (Object.keys(value).length !== 1)
      fail(`config.rules[${index}]`, "must be a single-key mapping");
    const [id, body] = Object.entries(value)[0];
    if (!ID.test(id)) fail(`config.rules[${index}]`, "invalid rule id");
    if (ruleIds.has(id))
      fail(`config.rules[${index}]`, `duplicate rule id: ${id}`);
    ruleIds.add(id);
    const rule = require_mapping(body, `config.rules[${index}].${id}`);
    reject_unknown_keys(rule, `config.rules[${index}].${id}`, [
      "mode",
      "condition",
    ]);
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
    const conditionId = condition(
      rule.condition,
      `config.rules[${index}].${id}.condition`,
    );
    if (mode === "repeat")
      repeatExits(rule.condition, `config.rules[${index}].${id}.condition`);
    rules.push({
      id: stringId(id),
      mode,
      condition: conditionId,
    });
  });
  const initial = range(
    actions(config.initial, "config.initial"),
    "config.initial",
  );
  const every_draw = range(
    actions(config.every_draw, "config.every_draw"),
    "config.every_draw",
  );
  const baseStrings = strings;
  const baseActions = actionArena;
  const baseConditions = conditions;
  const baseConditionChildren = condition_children;
  const baseResolve = resolve;
  const everyPathTerminates = (raw: unknown, path: string): boolean => {
    const node = require_mapping(raw, path);
    if (
      actions(node.actions, `${path}.actions`).some((entry) =>
        entry.trim().startsWith("terminate "),
      )
    )
      return true;
    if ("check" in node) return false;
    const children = require_list(node.children, `${path}.children`);
    return ["OR", "||"].includes(node.op as string)
      ? children.every((child, index) =>
          everyPathTerminates(child, `${path}.children[${index}]`),
        )
      : children.some((child, index) =>
          everyPathTerminates(child, `${path}.children[${index}]`),
        );
  };
  return {
    apply_termination(terminationValue, result_item, validate_only = false) {
      strings = [...baseStrings];
      actionArena = [...baseActions];
      conditions = [...baseConditions];
      condition_children = [...baseConditionChildren];
      resolve = baseResolve.map((entry) => ({
        ...entry,
        actions: { ...entry.actions },
      }));

      const termination = require_mapping(terminationValue, "termination");
      reject_unknown_keys(termination, "termination", [
        "retained_items",
        "termination_rule",
      ]);
      if ("schema_version" in termination)
        fail(
          "termination.schema_version",
          "must inherit config schema_version",
        );
      const retained = require_list(
        termination.retained_items,
        "termination.retained_items",
      );
      const retainedIds = new Set<string>();
      retained.forEach((raw, index) => {
        const path = `termination.retained_items[${index}]`;
        const value = require_mapping(raw, path);
        if (Object.keys(value).length !== 1)
          fail(path, "must be a single-key mapping");
        const [id, count] = Object.entries(value)[0];
        const item = itemIds.get(id);
        if (item == null || retainedIds.has(id))
          fail(path, "unknown or duplicate retained item");
        retainedIds.add(id);
        resolve[item].retain = Math.max(
          resolve[item].retain,
          integer(count, `${path}.${id}`),
        );
      });
      const termRule = require_mapping(
        termination.termination_rule,
        "termination.termination_rule",
      );
      reject_unknown_keys(termRule, "termination.termination_rule", [
        "condition",
      ]);
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
      let resultItem: number | undefined;
      if (!validate_only) {
        if (typeof result_item !== "string" || !ID.test(result_item))
          fail("result_item", "must be an item id");
        resultItem = itemIds.get(result_item);
        if (resultItem == null)
          fail("result_item", `unknown item id: ${result_item}`);
      }
      const termination_condition = condition(
        termRule.condition,
        "termination.termination_rule.condition",
      );
      if (validate_only) return;
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
          initial,
          every_draw,
          termination_condition,
        },
      };
    },
  };
}

export function validate_termination(
  config: PreparedConfig,
  terminationValue: unknown,
): void {
  config.apply_termination(terminationValue, undefined, true);
}

export function compile(
  configValue: unknown,
  terminationValue: unknown,
  manifestValue: unknown,
  result_item: string,
): CompiledProgram {
  require_mapping(configValue, "config");
  require_mapping(terminationValue, "termination");
  validate_config_manifest(manifestValue);
  return prepare_config(configValue).apply_termination(
    terminationValue,
    result_item,
  )!;
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
