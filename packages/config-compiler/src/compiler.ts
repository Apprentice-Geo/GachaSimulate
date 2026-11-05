import type { ActionRange, CompiledProgram } from "./types.js";
import type {
  CheckCondition,
  ItemAction,
  ItemResolve,
  ProgramIR,
} from "./ir.js";
import { ProgramBuilder } from "./program_builder.js";
import {
  ID,
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

type PreparedConfig = {
  compile_termination(value: unknown, result_item: string): CompiledProgram;
  validate_termination(value: unknown): void;
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
  const itemIds = new Map<string, number>();
  const poolIds = new Map<string, number>();
  const arena = new ProgramBuilder(itemIds, poolIds);
  const itemNames: string[] = [];
  const items: ProgramIR["items"] = [];
  config_items(config.items).forEach(({ id, name }) => {
    itemIds.set(id, items.length);
    itemNames.push(id);
    items.push({ id: arena.string_id(id), name: arena.string_id(name) });
  });
  const pools: ProgramIR["pools"] = [];
  const pool_entries: ProgramIR["pool_entries"] = [];
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
    pools.push({ id: arena.string_id(id), entries: { begin: 0, count: 0 } });
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
        actions: arena.add_actions(entry.actions, `${path}.actions`),
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
  const resolve: ItemResolve[] = Array.from({ length: items.length }, () => ({
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
    const action_range = arena.add_actions(value.actions, `${path}.actions`);
    const values = arena.action_slice(action_range);
    const reduce = values.filter(
      (entry): entry is ItemAction =>
        entry.kind === "reduce_item" && entry.item === item,
    );
    const reducesOtherItem = values.some(
      (entry) => entry.kind === "reduce_item" && entry.item !== item,
    );
    if (!values.length || reduce.length !== 1 || reducesOtherItem)
      fail(
        `${path}.actions`,
        "must contain exactly one reduce action for the resolved item and no other item reductions",
      );
    resolve[item] = {
      retain: integer(value.retain, `${path}.retain`),
      reduce_per_batch: reduce[0].amount,
      actions: action_range,
    };
  });
  const nodeNames = [
    ...pools.map((pool) => `pool ${arena.strings[pool.id]}`),
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
        const entry = arena.actions[actionRange.begin + i];
        if (entry.kind === "terminate") break;
        if (
          entry.kind === "add_item" ||
          entry.kind === "reduce_item" ||
          entry.kind === "set_item"
        ) {
          const item = entry.item;
          directWrites[node].add(item);
          if (entry.kind !== "reduce_item" && resolve[item].actions.count)
            edges[node].add(pools.length + item);
        } else if (entry.kind === "draw") {
          edges[node].add(entry.pool);
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
  const repeatExits = (node: CheckCondition, path: string): void => {
    const checkedItem = node.item;
    const nestedWrites = mayWrite(checkedItem);
    const checkedWrites: ItemAction[] = [];
    let nestedWrite = false;
    for (const entry of arena.action_slice(node.actions)) {
      if (entry.kind === "terminate") return;
      if (
        entry.kind === "add_item" ||
        entry.kind === "reduce_item" ||
        entry.kind === "set_item"
      ) {
        if (entry.item === checkedItem) checkedWrites.push(entry);
        if (
          entry.kind !== "reduce_item" &&
          resolve[entry.item].actions.count &&
          nestedWrites[pools.length + entry.item]
        )
          nestedWrite = true;
      } else if (entry.kind === "draw" && nestedWrites[entry.pool])
        nestedWrite = true;
    }
    if (nestedWrite)
      fail(
        `${path}.actions`,
        `nested pool or item resolver may write checked item: ${itemNames[checkedItem]}`,
      );
    if (checkedWrites.length !== 1)
      fail(`${path}.actions`, "must write checked item exactly once");
    const write = checkedWrites[0];
    const amount = write.amount;
    const compare = node.op;
    const value = node.value;
    const assignmentIsFalse =
      write.kind === "set_item" &&
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
      (((compare === ">=" || compare === ">") &&
        write.kind === "reduce_item") ||
        ((compare === "<=" || compare === "<") && write.kind === "add_item") ||
        (compare === "==" &&
          (write.kind === "add_item" || write.kind === "reduce_item")));
    if (!assignmentIsFalse && !monotonicExit)
      fail(
        `${path}.actions`,
        "the checked item write does not make the condition false",
      );
  };
  const rules: ProgramIR["rules"] = [];
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
    if (mode !== "once" && mode !== "per_draw" && mode !== "repeat")
      fail(`config.rules[${index}].${id}.mode`, "unsupported mode");
    const summary = arena.add_condition(
      rule.condition,
      `config.rules[${index}].${id}.condition`,
    );
    if (!summary.has_actions)
      fail(
        `config.rules[${index}].${id}.condition`,
        "must contain at least one action",
      );
    const conditionId = summary.id;
    if (mode === "repeat") {
      const node = arena.condition_nodes[conditionId];
      if (node.kind !== "check")
        fail(
          `config.rules[${index}].${id}.condition`,
          "repeat condition must be a single check",
        );
      repeatExits(node, `config.rules[${index}].${id}.condition`);
    }
    rules.push({
      id: arena.string_id(id),
      mode,
      condition: conditionId,
    });
  });
  const initial = arena.add_actions(config.initial, "config.initial");
  const every_draw = arena.add_actions(config.every_draw, "config.every_draw");
  const apply_termination = (terminationValue: unknown) => {
    const working = new ProgramBuilder(itemIds, poolIds, arena);
    const working_resolve = resolve.map((entry) => ({
      ...entry,
      actions: { ...entry.actions },
    }));

    const termination = require_mapping(terminationValue, "termination");
    reject_unknown_keys(termination, "termination", [
      "retained_items",
      "termination_rule",
    ]);
    if ("schema_version" in termination)
      fail("termination.schema_version", "must inherit config schema_version");
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
      working_resolve[item].retain = Math.max(
        working_resolve[item].retain,
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
    const summary = working.add_condition(
      termRule.condition,
      "termination.termination_rule.condition",
    );
    if (!summary.every_path_terminates)
      fail(
        "termination.termination_rule.condition",
        "every termination path must contain a terminate action",
      );
    return { working, working_resolve, termination_condition: summary.id };
  };
  return {
    validate_termination(value) {
      apply_termination(value);
    },
    compile_termination(value, result_item) {
      const { working, working_resolve, termination_condition } =
        apply_termination(value);
      if (typeof result_item !== "string" || !ID.test(result_item))
        fail("result_item", "must be an item id");
      const resultItem = itemIds.get(result_item);
      if (resultItem == null)
        fail("result_item", `unknown item id: ${result_item}`);
      return {
        ir: {
          result_item: resultItem,
          items,
          strings: working.strings,
          actions: working.actions,
          pools,
          pool_entries,
          rules,
          condition_nodes: working.condition_nodes,
          condition_children: working.condition_children,
          item_resolve: working_resolve,
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
  config.validate_termination(terminationValue);
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
  return prepare_config(configValue).compile_termination(
    terminationValue,
    result_item,
  );
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
