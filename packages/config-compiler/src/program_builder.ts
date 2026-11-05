import type { ActionRange, Comparison, ProgramIR } from "./ir.js";
import {
  actions,
  fail,
  integer,
  reject_unknown_keys,
  require_list,
  require_mapping,
} from "./validation.js";

const ACTION = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*(\+=|-=|=)[ \t]*(\d+)$/;
const COMMAND = /^(draw|change|terminate) +(.+)$/s;
const CHECK = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*(>=|<=|==|!=|>|<)[ \t]*(\d+)$/;

type Arena = Pick<
  ProgramIR,
  "strings" | "actions" | "condition_nodes" | "condition_children"
>;

type ConditionSummary = {
  id: number;
  has_actions: boolean;
  every_path_terminates: boolean;
};

/** One compilation's append-only arenas; termination builds fork the config arenas. */
export class ProgramBuilder implements Arena {
  readonly strings: Arena["strings"];
  readonly actions: Arena["actions"];
  readonly condition_nodes: Arena["condition_nodes"];
  readonly condition_children: Arena["condition_children"];
  private readonly string_ids: Map<string, number>;

  constructor(
    private readonly item_ids: ReadonlyMap<string, number>,
    private readonly pool_ids: ReadonlyMap<string, number>,
    base?: Arena,
  ) {
    this.strings = [...(base?.strings ?? [])];
    this.actions = [...(base?.actions ?? [])];
    this.condition_nodes = [...(base?.condition_nodes ?? [])];
    this.condition_children = [...(base?.condition_children ?? [])];
    this.string_ids = new Map(this.strings.map((value, id) => [value, id]));
  }

  string_id(value: string): number {
    const found = this.string_ids.get(value);
    if (found !== undefined) return found;
    const id = this.strings.length;
    this.strings.push(value);
    this.string_ids.set(value, id);
    return id;
  }

  add_actions(raw: unknown, path: string): ActionRange {
    const begin = this.actions.length;
    actions(raw, path).forEach((value, index) => {
      const action_path = `${path}[${index}]`;
      const text = value.trim();
      const item = ACTION.exec(text);
      if (item) {
        const id = this.item_ids.get(item[1]);
        if (id == null) fail(action_path, `unknown item id: ${item[1]}`);
        this.actions.push({
          kind:
            item[2] === "+="
              ? "add_item"
              : item[2] === "-="
                ? "reduce_item"
                : "set_item",
          item: id,
          amount: integer(Number(item[3]), action_path, item[2] !== "="),
        });
        return;
      }
      const command = COMMAND.exec(text);
      if (command) {
        // Preserve the existing normalization of whitespace within reason text.
        const target = command[2].trim().split(/\s+/).join(" ");
        if (command[1] === "terminate" && target) {
          this.actions.push({
            kind: "terminate",
            reason: this.string_id(target),
          });
          return;
        }
        if (command[1] === "draw" || command[1] === "change") {
          const pool = this.pool_ids.get(target);
          if (pool == null) fail(action_path, `unknown pool id: ${target}`);
          this.actions.push({ kind: command[1], pool });
          return;
        }
      }
      fail(action_path, `unsupported action: ${value}`);
    });
    return { begin, count: this.actions.length - begin };
  }

  action_slice(range: ActionRange) {
    return this.actions.slice(range.begin, range.begin + range.count);
  }

  add_condition(raw: unknown, path: string): ConditionSummary {
    const node = require_mapping(raw, path);
    const own = this.add_actions(node.actions, `${path}.actions`);
    const terminates = this.action_slice(own).some(
      (action) => action.kind === "terminate",
    );
    if ("check" in node) {
      reject_unknown_keys(node, path, ["check", "actions"]);
      if (typeof node.check !== "string")
        fail(`${path}.check`, "must be a condition string");
      const match = CHECK.exec(node.check.trim());
      if (!match) fail(`${path}.check`, "unsupported condition");
      const item = this.item_ids.get(match[1]);
      if (item == null) fail(`${path}.check`, `unknown item id: ${match[1]}`);
      const id = this.condition_nodes.length;
      this.condition_nodes.push({
        kind: "check",
        item,
        op: match[2] as Comparison,
        value: integer(Number(match[3]), `${path}.check`),
        actions: own,
      });
      return {
        id,
        has_actions: own.count > 0,
        every_path_terminates: terminates,
      };
    }
    reject_unknown_keys(node, path, ["op", "children", "actions"]);
    const op = node.op === "&&" ? "AND" : node.op === "||" ? "OR" : node.op;
    if (op !== "AND" && op !== "OR") fail(`${path}.op`, "unsupported logic op");
    const children = require_list(node.children, `${path}.children`);
    if (!children.length) fail(`${path}.children`, "must be non-empty");
    const begin = this.condition_children.length;
    this.condition_children.length += children.length;
    const summaries = children.map((child, index) => {
      const summary = this.add_condition(child, `${path}.children[${index}]`);
      this.condition_children[begin + index] = summary.id;
      return summary;
    });
    const id = this.condition_nodes.length;
    this.condition_nodes.push({
      kind: "logic",
      op,
      children: { begin, count: children.length },
      actions: own,
    });
    return {
      id,
      has_actions:
        own.count > 0 || summaries.some((child) => child.has_actions),
      every_path_terminates:
        terminates ||
        (op === "OR"
          ? summaries.every((child) => child.every_path_terminates)
          : summaries.some((child) => child.every_path_terminates)),
    };
  }
}
