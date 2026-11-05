import type { Action, CompiledProgram, Condition } from "../src/index.js";

const actions: Action[] = [
  { kind: "draw", pool: 0 },
  // @ts-expect-error draw actions require a pool index
  { kind: "draw", poll: 0 },
  // @ts-expect-error terminate actions use a string index
  { kind: "terminate", reason: "done" },
];
const conditions: Condition[] = [
  {
    kind: "check",
    item: 0,
    // @ts-expect-error condition comparisons are a closed set
    op: "===",
    value: 1,
    actions: { begin: 0, count: 0 },
  },
];
// @ts-expect-error a compiled program must contain every required IR field
const program: CompiledProgram = { ir: { result_item: 0 } };
void [actions, conditions, program];
