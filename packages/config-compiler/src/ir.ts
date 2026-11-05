export type ActionRange = { begin: number; count: number };

export type ItemAction = {
  kind: "add_item" | "reduce_item" | "set_item";
  item: number;
  amount: number;
};

export type Action =
  | ItemAction
  | { kind: "draw" | "change"; pool: number }
  | { kind: "terminate"; reason: number };

export type Comparison = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type CheckCondition = {
  kind: "check";
  item: number;
  op: Comparison;
  value: number;
  actions: ActionRange;
};

export type Condition =
  | CheckCondition
  | {
      kind: "logic";
      op: "AND" | "OR";
      children: ActionRange;
      actions: ActionRange;
    };

export type ItemResolve = {
  retain: number;
  reduce_per_batch: number;
  actions: ActionRange;
};

export type RuleMode = "once" | "per_draw" | "repeat";

export type ProgramIR = {
  result_item: number;
  items: { id: number; name: number }[];
  strings: string[];
  actions: Action[];
  pools: { id: number; entries: ActionRange }[];
  pool_entries: { threshold: number; actions: ActionRange }[];
  rules: { id: number; mode: RuleMode; condition: number }[];
  condition_nodes: Condition[];
  condition_children: number[];
  item_resolve: ItemResolve[];
  initial: ActionRange;
  every_draw: ActionRange;
  termination_condition: number;
};
