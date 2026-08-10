import assert from "node:assert/strict";
import test from "node:test";
import { CompilerError, compile_yaml } from "../src/index.js";

const config = `schema_version: 1
items: [target]
pools:
  - main:
      - probability: 1
        actions: target += 1
`;
const termination = `retained_items: []
termination_rule:
  condition:
    check: target >= 1
    actions: terminate done
`;

test("compiles v1 YAML with the compiler-owned draw slot", () => {
  const { ir } = compile_yaml(config, termination);
  assert.equal(ir.ir_version, 1);
  assert.equal(ir.draw_count_item, 0);
  assert.deepEqual((ir.items as { id: number }[]).length, 2);
});

test("emits the resolve batch reduction without making consumers rescan actions", () => {
  const { ir } = compile_yaml(
    config.replace("target += 1", "target += 3").replace(
      "pools:\n",
      "item_resolve:\n  - item: target\n    retain: 1\n    actions: target -= 2\npools:\n",
    ),
    termination,
  );
  const resolves = ir.item_resolve as { retain: number; reduce_per_batch: number }[];
  assert.deepEqual(resolves.map(({ retain, reduce_per_batch }) => ({ retain, reduce_per_batch })), [
    { retain: 0, reduce_per_batch: 0 },
    { retain: 1, reduce_per_batch: 2 },
  ]);
});

test("rejects duplicate YAML keys and draw_count writes", () => {
  assert.throws(
    () => compile_yaml(config.replace("items: [target]", "items: [target]\nitems: [other]"), termination),
    CompilerError,
  );
  assert.throws(
    () => compile_yaml(config.replace("target += 1", "draw_count += 1"), termination),
    /read-only/,
  );
});

test("emits cost_item only when manifest metrics and cost_count agree", () => {
  const withCost = config.replace("items: [target]", "items: [target, cost_count]");
  assert.equal((compile_yaml(withCost, termination, "metrics: [draw, cost]").ir as { cost_item: number }).cost_item, 2);
  assert.throws(() => compile_yaml(config, termination, "metrics: [cost]"), /cost_count/);
  assert.throws(() => compile_yaml(withCost, termination, "metrics: [draw]"), /cost requires/);
});
