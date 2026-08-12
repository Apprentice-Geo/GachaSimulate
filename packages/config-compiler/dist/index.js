import { parseDocument } from "yaml";
const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ACTION = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\+=|-=|=)\s*(\d+)$/;
const CHECK = /^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|==|!=|>|<)\s*(\d+)$/;
export class CompilerError extends Error {
    path;
    constructor(path, message) {
        super(`${path}: ${message}`);
        this.path = path;
        this.name = "CompilerError";
    }
}
function fail(path, message) {
    throw new CompilerError(path, message);
}
function map(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail(path, "must be a mapping");
    return value;
}
function list(value, path) {
    if (!Array.isArray(value))
        fail(path, "must be a list");
    return value;
}
function integer(value, path, positive = false) {
    if (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < (positive ? 1 : 0))
        fail(path, `must be a ${positive ? "positive" : "non-negative"} safe integer`);
    return value;
}
function number(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        fail(path, "must be a finite positive number");
    return value;
}
function keys(value, path, allowed) {
    for (const key of Object.keys(value))
        if (!allowed.includes(key))
            fail(`${path}.${key}`, "unsupported field");
}
function actions(value, path) {
    if (value == null)
        return [];
    const result = typeof value === "string" ? [value] : list(value, path);
    result.forEach((item, index) => {
        if (typeof item !== "string")
            fail(`${path}[${index}]`, "must be an action string");
    });
    return result;
}
function parse_yaml(text, name) {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length)
        fail(name, document.errors[0].message.replace(/\n.*/s, ""));
    return map(document.toJS(), name);
}
function config_items(value) {
    const rawItems = list(value, "config.items");
    if (!rawItems.length)
        fail("config.items", "must be non-empty");
    const itemIds = new Set();
    return rawItems.map((entry, index) => {
        let id, name;
        if (typeof entry === "string")
            id = name = entry;
        else {
            const single = map(entry, `config.items[${index}]`);
            if (Object.keys(single).length !== 1)
                fail(`config.items[${index}]`, "must be a single-key mapping");
            [id, name] = Object.entries(single)[0];
        }
        if (!ID.test(id))
            fail(`config.items[${index}]`, "invalid item id");
        if (itemIds.has(id))
            fail(`config.items[${index}]`, `duplicate item id: ${id}`);
        if (typeof name !== "string" || !name)
            fail(`config.items[${index}]`, "name must be a non-empty string");
        itemIds.add(id);
        return { id, name };
    });
}
export function read_config_items(config_text) {
    return config_items(parse_yaml(config_text, "config").items);
}
/** Compiles the v2 YAML contract to a JSON-serializable, flat arena IR. */
export function compile_yaml(config_text, termination_text, manifest_text, result_item) {
    return compile(parse_yaml(config_text, "config"), parse_yaml(termination_text, "termination"), parse_yaml(manifest_text, "manifest"), result_item);
}
export function compile(configValue, terminationValue, manifestValue, result_item) {
    const config = map(configValue, "config");
    const termination = map(terminationValue, "termination");
    const manifest = map(manifestValue, "manifest");
    keys(config, "config", [
        "schema_version",
        "items",
        "pools",
        "initial",
        "every_draw",
        "rules",
        "item_resolve",
    ]);
    if (config.schema_version !== 2)
        fail("config.schema_version", "must be 2");
    keys(termination, "termination", ["retained_items", "termination_rule"]);
    if ("schema_version" in termination)
        fail("termination.schema_version", "must inherit config schema_version");
    keys(manifest, "manifest", [
        "id",
        "name",
        "description",
        "terminations",
        "metadata",
    ]);
    const strings = [];
    const stringId = (value) => {
        const found = strings.indexOf(value);
        if (found >= 0)
            return found;
        strings.push(value);
        return strings.length - 1;
    };
    const itemIds = new Map();
    const items = [];
    config_items(config.items).forEach(({ id, name }) => {
        itemIds.set(id, items.length);
        items.push({ id: stringId(id), name: stringId(name) });
    });
    const pools = [];
    const poolIds = new Map();
    const pool_entries = [];
    const actionArena = [];
    const range = (values, path) => {
        const begin = actionArena.length;
        values.forEach((value, i) => actionArena.push(action(value, `${path}[${i}]`)));
        return { begin, count: actionArena.length - begin };
    };
    const action = (value, path) => {
        const item = ACTION.exec(value.trim());
        if (item) {
            const index = itemIds.get(item[1]);
            if (index == null)
                fail(path, `unknown item id: ${item[1]}`);
            const amount = integer(Number(item[3]), path, item[2] !== "=");
            return {
                kind: item[2] === "+="
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
            if (index == null)
                fail(path, `unknown pool id: ${target}`);
            return { kind: command, pool: index };
        }
        if (command === "terminate" && target)
            return { kind: "terminate", reason: stringId(target) };
        fail(path, `unsupported action: ${value}`);
    };
    const rawPools = list(config.pools, "config.pools");
    if (!rawPools.length)
        fail("config.pools", "must be non-empty");
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
        const [id, rawEntries] = Object.entries(map(entry, `config.pools[${index}]`))[0];
        const entries = list(rawEntries, `config.pools[${index}].${id}`);
        if (!entries.length)
            fail(`config.pools[${index}].${id}`, "must be non-empty");
        const begin = pool_entries.length;
        let total = 0;
        let weighted;
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
            total += number(entry[isWeight ? "weight" : "probability"], `${path}.${isWeight ? "weight" : "probability"}`);
            pool_entries.push({
                threshold: total,
                actions: range(actions(entry.actions, `${path}.actions`), `${path}.actions`),
            });
        });
        if (!weighted && Math.abs(total - 1) > 1e-9)
            fail(`config.pools[${index}].${id}`, "probability sum must be 1");
        const slice = pool_entries.slice(begin);
        slice.forEach((entry) => {
            entry.threshold = weighted ? entry.threshold / total : entry.threshold;
        });
        slice.at(-1).threshold = 1;
        pools[index].entries = { begin, count: slice.length };
    });
    const conditions = [];
    const condition_children = [];
    const condition = (raw, path) => {
        const node = map(raw, path);
        const own = range(actions(node.actions, `${path}.actions`), `${path}.actions`);
        if ("check" in node) {
            keys(node, path, ["check", "actions"]);
            if (typeof node.check !== "string")
                fail(`${path}.check`, "must be a condition string");
            const match = CHECK.exec(node.check.trim());
            if (!match)
                fail(`${path}.check`, "unsupported condition");
            const item = itemIds.get(match[1]);
            if (item == null)
                fail(`${path}.check`, `unknown item id: ${match[1]}`);
            return (conditions.push({
                kind: "check",
                item,
                op: match[2],
                value: integer(Number(match[3]), `${path}.check`),
                actions: own,
            }) - 1);
        }
        keys(node, path, ["op", "children", "actions"]);
        if (!["AND", "OR", "&&", "||"].includes(node.op))
            fail(`${path}.op`, "unsupported logic op");
        const children = list(node.children, `${path}.children`);
        if (!children.length)
            fail(`${path}.children`, "must be non-empty");
        const begin = condition_children.length;
        children.forEach((child, index) => condition_children.push(condition(child, `${path}.children[${index}]`)));
        return (conditions.push({
            kind: "logic",
            op: node.op === "&&" ? "AND" : node.op === "||" ? "OR" : node.op,
            children: { begin, count: children.length },
            actions: own,
        }) - 1);
    };
    const resolve = Array.from({ length: items.length }, () => ({
        retain: 0,
        reduce_per_batch: 0,
        actions: { begin: 0, count: 0 },
    }));
    const resolves = config.item_resolve == null
        ? []
        : list(config.item_resolve, "config.item_resolve");
    resolves.forEach((raw, index) => {
        const path = `config.item_resolve[${index}]`;
        const value = map(raw, path);
        keys(value, path, ["item", "retain", "actions"]);
        const item = typeof value.item === "string" ? itemIds.get(value.item) : undefined;
        if (item == null || resolve[item].actions.count)
            fail(`${path}.item`, "unknown or duplicate resolved item");
        const values = actions(value.actions, `${path}.actions`);
        const reduce = values
            .map((entry) => ACTION.exec(entry.trim()))
            .filter((match) => match != null && match[1] === value.item && match[2] === "-=");
        if (!values.length || reduce.length !== 1)
            fail(`${path}.actions`, "must contain exactly one reduce action for the resolved item");
        resolve[item] = {
            retain: integer(value.retain, `${path}.retain`),
            reduce_per_batch: integer(Number(reduce[0][3]), `${path}.actions`, true),
            actions: range(values, `${path}.actions`),
        };
    });
    const retained = list(termination.retained_items, "termination.retained_items");
    const retainedIds = new Set();
    retained.forEach((raw, index) => {
        const value = map(raw, `termination.retained_items[${index}]`);
        if (Object.keys(value).length !== 1)
            fail(`termination.retained_items[${index}]`, "must be a single-key mapping");
        const [id, count] = Object.entries(value)[0];
        const item = itemIds.get(id);
        if (item == null || retainedIds.has(id))
            fail(`termination.retained_items[${index}]`, "unknown or duplicate retained item");
        retainedIds.add(id);
        resolve[item].retain = Math.max(resolve[item].retain, integer(count, `termination.retained_items[${index}].${id}`));
    });
    const everyPathHasAction = (raw, path) => {
        const node = map(raw, path);
        if (actions(node.actions, `${path}.actions`).length)
            return true;
        if ("check" in node)
            return false;
        const children = list(node.children, `${path}.children`);
        return ["OR", "||"].includes(node.op)
            ? children.every((child, index) => everyPathHasAction(child, `${path}.children[${index}]`))
            : children.some((child, index) => everyPathHasAction(child, `${path}.children[${index}]`));
    };
    const rules = [];
    const rawRules = config.rules == null ? [] : list(config.rules, "config.rules");
    rawRules.forEach((raw, index) => {
        const value = map(raw, `config.rules[${index}]`);
        if (Object.keys(value).length !== 1)
            fail(`config.rules[${index}]`, "must be a single-key mapping");
        const [id, body] = Object.entries(value)[0];
        const rule = map(body, `config.rules[${index}].${id}`);
        keys(rule, `config.rules[${index}].${id}`, ["mode", "condition"]);
        const mode = rule.mode ?? "once";
        if (!["once", "per_draw", "repeat"].includes(mode))
            fail(`config.rules[${index}].${id}.mode`, "unsupported mode");
        if (mode === "repeat" &&
            !everyPathHasAction(rule.condition, `config.rules[${index}].${id}.condition`))
            fail(`config.rules[${index}].${id}.condition`, "every repeat path must contain at least one action");
        rules.push({
            id: stringId(id),
            mode,
            condition: condition(rule.condition, `config.rules[${index}].${id}.condition`),
        });
    });
    const everyPathTerminates = (raw, path) => {
        const node = map(raw, path);
        if (actions(node.actions, `${path}.actions`).some((entry) => entry.trim().startsWith("terminate ")))
            return true;
        if ("check" in node)
            return false;
        const children = list(node.children, `${path}.children`);
        return ["OR", "||"].includes(node.op)
            ? children.every((child, index) => everyPathTerminates(child, `${path}.children[${index}]`))
            : children.some((child, index) => everyPathTerminates(child, `${path}.children[${index}]`));
    };
    const termRule = map(termination.termination_rule, "termination.termination_rule");
    keys(termRule, "termination.termination_rule", ["condition"]);
    if (!everyPathTerminates(termRule.condition, "termination.termination_rule.condition"))
        fail("termination.termination_rule.condition", "every termination path must contain a terminate action");
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
            initial: range(actions(config.initial, "config.initial"), "config.initial"),
            every_draw: range(actions(config.every_draw, "config.every_draw"), "config.every_draw"),
            termination: range([], "termination"),
            termination_condition: condition(termRule.condition, "termination.termination_rule.condition"),
        },
    };
}
