import assert from "node:assert/strict";
import test from "node:test";
import { default_result_item, selected_result_item } from "./simulation_items";

const items = [
  { id: "target", name: "目标" },
  { id: "draw_count", name: "抽数" },
];

test("selects draw_count by default and otherwise the first item", () => {
  assert.equal(default_result_item(items), "draw_count");
  assert.equal(default_result_item(items.slice(0, 1)), "target");
});

test("accepts only a trimmed, case-sensitive complete item id", () => {
  assert.equal(selected_result_item(" target ", items), "target");
  for (const input of ["目标", "tar", "missing", "TARGET"])
    assert.equal(selected_result_item(input, items), null);
});
