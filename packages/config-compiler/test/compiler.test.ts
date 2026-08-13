import assert from "node:assert/strict";
import test from "node:test";
import {
  CompilerError,
  compile,
  compile_yaml,
  read_config_items,
  read_config_manifest,
} from "../src/index.js";

const config = `schema_version: 2
items: [draw_count, target]
pools:
  - main:
      - probability: 1
        actions: target += 1
every_draw: draw_count += 1
`;
const termination = `retained_items: []
termination_rule:
  condition:
    check: target >= 1
    actions: terminate done
`;
const manifest = `id: test
name: Test
description: Test config
terminations:
  - file: termination.yaml
    name: Done
`;

test("compiles v2 YAML with the simulation-selected result item", () => {
  const draw = compile_yaml(config, termination, manifest, "draw_count").ir;
  const target = compile_yaml(config, termination, manifest, "target").ir;
  assert.equal(draw.ir_version, 2);
  assert.equal(draw.result_item, 0);
  assert.equal(target.result_item, 1);
  assert.deepEqual((draw.items as { id: number }[]).length, 2);
});

test("uses an item id as its display name when no name is provided", () => {
  const { ir } = compile_yaml(
    config.replace(
      "items: [draw_count, target]",
      "items: [{draw_count: 抽数}, target]",
    ),
    termination,
    manifest,
    "draw_count",
  );
  assert.equal(
    (ir.strings as string[])[(ir.items as { name: number }[])[1].name],
    "target",
  );
});

test("reads config items with the compiler's item validation", () => {
  assert.deepEqual(read_config_items("items: [draw_count, {target: 目标}]\n"), [
    { id: "draw_count", name: "draw_count" },
    { id: "target", name: "目标" },
  ]);
  for (const source of [
    "items: []\n",
    "items: [bad-id]\n",
    "items: [same, same]\n",
    "items: [{valid: ''}]\n",
    "items: [unterminated\n",
  ])
    assert.throws(() => read_config_items(source), CompilerError);
});

test("emits the resolve batch reduction without making consumers rescan actions", () => {
  const { ir } = compile_yaml(
    config
      .replace("target += 1", "target += 3")
      .replace(
        "pools:\n",
        "item_resolve:\n  - item: target\n    retain: 1\n    actions: target -= 2\npools:\n",
      ),
    termination,
    manifest,
    "draw_count",
  );
  const resolves = ir.item_resolve as {
    retain: number;
    reduce_per_batch: number;
  }[];
  assert.deepEqual(
    resolves.map(({ retain, reduce_per_batch }) => ({
      retain,
      reduce_per_batch,
    })),
    [
      { retain: 0, reduce_per_batch: 0 },
      { retain: 1, reduce_per_batch: 2 },
    ],
  );
});

test("rejects duplicate YAML keys, old schemas, metrics, and unknown result items", () => {
  assert.throws(
    () =>
      compile_yaml(
        config.replace(
          "items: [draw_count, target]",
          "items: [draw_count, target]\nitems: [other]",
        ),
        termination,
        manifest,
        "draw_count",
      ),
    CompilerError,
  );
  assert.throws(
    () =>
      compile_yaml(
        config.replace("schema_version: 2", "schema_version: 1"),
        termination,
        manifest,
        "draw_count",
      ),
    /must be 2/,
  );
  assert.throws(
    () => compile_yaml(config, termination, "metrics: [draw]\n", "draw_count"),
    /unsupported field/,
  );
  assert.throws(
    () =>
      compile_yaml(config, termination, "result_item: target\n", "draw_count"),
    /unsupported field/,
  );
  assert.throws(
    () => compile_yaml(config, termination, manifest, "missing"),
    /unknown item id/,
  );
});

test("requires a manifest and allows draw_count to be a normal writable item", () => {
  assert.throws(
    () => compile_yaml(config, termination, "", "draw_count"),
    CompilerError,
  );
  assert.doesNotThrow(() =>
    compile_yaml(config, termination, manifest, "draw_count"),
  );
});

test("validates rule ids and requires every rule to contain an action", () => {
  for (const rules of [
    `rules:
  - bad-id:
      condition: {check: target >= 1, actions: target += 1}
`,
    `rules:
  - same:
      condition: {check: target >= 1, actions: target += 1}
  - same:
      condition: {check: target >= 2, actions: target += 1}
`,
    `rules:
  - empty:
      condition: {check: target >= 1}
`,
  ])
    assert.throws(
      () => compile_yaml(config + rules, termination, manifest, "draw_count"),
      CompilerError,
    );
});

test("rejects resolve actions that reduce another item", () => {
  assert.throws(
    () =>
      compile_yaml(
        config
          .replace(
            "items: [draw_count, target]",
            "items: [draw_count, target, other]",
          )
          .replace(
            "pools:\n",
            "item_resolve:\n  - item: target\n    retain: 0\n    actions: [target -= 1, other -= 1]\npools:\n",
          ),
        termination,
        manifest,
        "draw_count",
      ),
    /no other item reductions/,
  );
});

test("reads and validates manifests through the shared compiler contract", () => {
  assert.deepEqual(
    read_config_manifest(
      manifest + "metadata:\n  source: test\n  nested: [anything, 1]\n",
    ),
    {
      id: "test",
      name: "Test",
      description: "Test config",
      terminations: [{ file: "termination.yaml", name: "Done" }],
      metadata: { source: "test", nested: ["anything", 1] },
    },
  );
  for (const source of [
    "name: Test\ndescription: Test\nterminations: [{file: done.yaml, name: Done}]\n",
    "id: bad.id\nname: Test\ndescription: Test\nterminations: [{file: done.yaml, name: Done}]\n",
    "id: test\nname: ''\ndescription: Test\nterminations: [{file: done.yaml, name: Done}]\n",
    "id: test\nname: Test\nterminations: [{file: done.yaml, name: Done}]\n",
    "id: test\nname: Test\ndescription: Test\nterminations: []\n",
    "id: test\nname: Test\ndescription: Test\nterminations: [{file: '', name: Done}]\n",
    "id: test\nname: Test\ndescription: Test\nterminations: [{file: nested/done.yaml, name: Done}]\n",
    "id: test\nname: Test\ndescription: Test\nterminations: [{file: done.yaml, name: ''}]\n",
  ])
    assert.throws(() => read_config_manifest(source), CompilerError);

  assert.throws(
    () => compile({}, {}, { id: "invalid" }, "draw_count"),
    /manifest.name/,
  );
  assert.throws(
    () => compile_yaml(config, termination, "id: invalid\n", "draw_count"),
    /manifest.name/,
  );
});
