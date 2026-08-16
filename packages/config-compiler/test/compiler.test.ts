import assert from "node:assert/strict";
import test from "node:test";
import {
  CompilerError,
  YAML_TEXT_LIMIT,
  compile,
  compile_yaml,
  read_config_items,
  read_config_manifest,
  validate_config_files,
} from "../src/index.js";

function padded(source: string, bytes: number): string {
  return `${source}#${"x".repeat(bytes - Buffer.byteLength(source) - 2)}\n`;
}

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

test("keeps direct nested condition children contiguous", () => {
  const { ir } = compile_yaml(
    config,
    `retained_items: []
termination_rule:
  condition:
    op: OR
    children:
    - op: AND
      children:
      - check: target >= 1
      - check: draw_count >= 1
      actions: terminate both
    - check: target >= 2
      actions: terminate target
`,
    manifest,
    "draw_count",
  );
  const nodes = ir.condition_nodes as {
    kind: string;
    children?: { begin: number; count: number };
  }[];
  const childIds = ir.condition_children as number[];
  const root = nodes[ir.termination_condition as number];
  const rootChildren = childIds.slice(
    root.children!.begin,
    root.children!.begin + root.children!.count,
  );

  assert.deepEqual(
    rootChildren.map((id) => nodes[id].kind),
    ["logic", "check"],
  );
  const nested = nodes[rootChildren[0]];
  assert.deepEqual(
    childIds
      .slice(
        nested.children!.begin,
        nested.children!.begin + nested.children!.count,
      )
      .map((id) => nodes[id].kind),
    ["check", "check"],
  );
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
  assert.throws(
    () => compile_yaml(config, termination, manifest, undefined as never),
    /result_item/,
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

test("limits every YAML input to 1 MiB and rejects aliases", () => {
  assert.doesNotThrow(() =>
    read_config_items(padded("items: [draw_count]\n", YAML_TEXT_LIMIT)),
  );
  assert.throws(
    () =>
      read_config_items(padded("items: [draw_count]\n", YAML_TEXT_LIMIT + 1)),
    /1 MiB/,
  );
  assert.throws(
    () =>
      compile_yaml(
        config,
        padded(termination, YAML_TEXT_LIMIT + 1),
        manifest,
        "draw_count",
      ),
    /termination.*1 MiB/,
  );
  assert.throws(
    () => read_config_manifest(padded(manifest, YAML_TEXT_LIMIT + 1)),
    /manifest.*1 MiB/,
  );
  assert.throws(
    () => read_config_items("items: &items [draw_count]\ncopy: *items\n"),
    /alias/i,
  );
});

test("validates one config against termination files in input order", () => {
  const badField = `${termination}unknown: true\n`;
  const badReference = termination.replace("target >= 1", "missing >= 1");
  assert.deepEqual(
    validate_config_files(config, [
      { file: "first.yaml", text: termination },
      { file: "second.yaml", text: badField },
      { file: "third.yaml", text: badReference },
      { file: "fourth.yaml", text: termination },
    ]),
    ["second.yaml", "third.yaml"],
  );
});

test("short-circuits invalid configs and validates configs without terminations", () => {
  assert.deepEqual(validate_config_files(config, []), []);
  assert.deepEqual(
    validate_config_files(`${config}unknown: true\n`, [
      { file: "broken.yaml", text: "not: [valid" },
    ]),
    ["config.yaml"],
  );
  assert.deepEqual(
    validate_config_files(
      config.replace("every_draw: draw_count += 1", "every_draw: missing += 1"),
      [],
    ),
    ["config.yaml"],
  );
});

test("applies the YAML size limit to every batch input", () => {
  assert.deepEqual(
    validate_config_files(padded(config, YAML_TEXT_LIMIT), [
      {
        file: "termination.yaml",
        text: padded(termination, YAML_TEXT_LIMIT),
      },
    ]),
    [],
  );
  assert.deepEqual(
    validate_config_files(padded(config, YAML_TEXT_LIMIT + 1), []),
    ["config.yaml"],
  );
  assert.deepEqual(
    validate_config_files(config, [
      {
        file: "too-large.yaml",
        text: padded(termination, YAML_TEXT_LIMIT + 1),
      },
    ]),
    ["too-large.yaml"],
  );
});

test("does not swallow unexpected batch validation errors", () => {
  const unexpected = new Error("unexpected");
  const input = {
    file: "termination.yaml",
    get text(): string {
      throw unexpected;
    },
  };
  assert.throws(() => validate_config_files(config, [input]), unexpected);
});
