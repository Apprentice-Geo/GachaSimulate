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
