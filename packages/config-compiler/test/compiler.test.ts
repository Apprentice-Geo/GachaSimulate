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
  assert.deepEqual(read_config_items('items: [{emoji: "😀"}]\n'), [
    { id: "emoji", name: "😀" },
  ]);
  for (const source of [
    "items: []\n",
    "items: [bad-id]\n",
    "items: [same, same]\n",
    "items: [{valid: ''}]\n",
    'items: [{valid: "\uD800"}]\n',
    'items: [{valid: "\uDC00"}]\n',
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

test("keeps safe-integer resolve values above uint32", () => {
  const large = 4_294_967_296;
  const { ir } = compile_yaml(
    config.replace(
      "pools:\n",
      `item_resolve:\n  - item: target\n    retain: ${large}\n    actions: target -= ${large}\npools:\n`,
    ),
    termination,
    manifest,
    "draw_count",
  );
  const resolve = (ir.item_resolve as Record<string, number>[])[1];
  assert.equal(resolve.retain, large);
  assert.equal(resolve.reduce_per_batch, large);
});

test("rejects an infinite weighted pool sum but normalizes large finite weights", () => {
  const weighted = config.replace(
    "- probability: 1\n        actions: target += 1",
    "- weight: 8e307\n        actions: target += 1\n      - weight: 8e307\n        actions: target += 1",
  );
  const { ir } = compile_yaml(weighted, termination, manifest, "draw_count");
  assert.deepEqual(
    (ir.pool_entries as { threshold: number }[]).map(
      ({ threshold }) => threshold,
    ),
    [0.5, 1],
  );
  assert.throws(
    () =>
      compile_yaml(
        weighted.replaceAll("8e307", "1e308"),
        termination,
        manifest,
        "draw_count",
      ),
    /config\.pools\[0\]\.main: weight sum must be finite/,
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

test("accepts only repeat rules with a provable local exit", () => {
  const valid = `${config}rules:
  - down:
      mode: repeat
      condition: {check: target >= 1, actions: target -= 1}
  - up:
      mode: repeat
      condition: {check: target <= 1, actions: target += 1}
  - leave_equal:
      mode: repeat
      condition: {check: target == 1, actions: target += 1}
  - reach_equal:
      mode: repeat
      condition: {check: target != 1, actions: target = 1}
  - assign_false:
      mode: repeat
      condition: {check: target >= 1, actions: target = 0}
  - stop:
      mode: repeat
      condition: {check: target >= 1, actions: terminate done}
`;
  assert.doesNotThrow(() =>
    compile_yaml(valid, termination, manifest, "draw_count"),
  );

  for (const [condition, message] of [
    [
      "{check: target >= 1, actions: draw_count += 1}",
      /write checked item exactly once/,
    ],
    [
      "{check: target >= 1, actions: target += 1}",
      /does not make the condition false/,
    ],
    [
      "{check: target >= 1, actions: [target -= 1, target -= 1]}",
      /write checked item exactly once/,
    ],
    [
      "{op: AND, children: [{check: target >= 1, actions: target -= 1}]}",
      /single check/,
    ],
  ] as const)
    assert.throws(
      () =>
        compile_yaml(
          `${config}rules:\n  - bad:\n      mode: repeat\n      condition: ${condition}\n`,
          termination,
          manifest,
          "draw_count",
        ),
      message,
    );
});

test("rejects repeat writes through nested pools or resolvers", () => {
  const nested = `schema_version: 2
items: [draw_count, target, token]
pools:
- main:
  - probability: 1
    actions: target += 1
- nested:
  - probability: 1
    actions: target += 1
item_resolve:
- item: token
  retain: 0
  actions: [token -= 1, target += 1]
rules:
- pool_write:
    mode: repeat
    condition:
      check: target >= 1
      actions: [draw nested, target -= 1]
`;
  assert.throws(
    () => compile_yaml(nested, termination, manifest, "draw_count"),
    /nested pool or item resolver may write checked item: target/,
  );
  assert.throws(
    () =>
      compile_yaml(
        nested
          .replace("[draw nested, target -= 1]", "[token += 1, target -= 1]")
          .replace("- pool_write:", "- resolver_write:"),
        termination,
        manifest,
        "draw_count",
      ),
    /nested pool or item resolver may write checked item: target/,
  );
});

test("rejects synchronous pool and item resolver call cycles", () => {
  const base = `schema_version: 2
items: [draw_count, target, gift, token]
`;
  for (const [body, cycle] of [
    [
      `pools:
- main:
  - probability: 1
    actions: draw main
`,
      /pool main -> pool main/,
    ],
    [
      `pools:
- a:
  - probability: 1
    actions: draw b
- b:
  - probability: 1
    actions: draw a
`,
      /pool a -> pool b -> pool a/,
    ],
    [
      `pools:
- main:
  - probability: 1
    actions: gift += 1
item_resolve:
- item: gift
  retain: 0
  actions: [gift -= 1, draw main]
`,
      /pool main -> resolve gift -> pool main/,
    ],
    [
      `pools:
- main:
  - probability: 1
    actions: target += 1
item_resolve:
- item: gift
  retain: 0
  actions: [gift -= 1, token += 1]
- item: token
  retain: 0
  actions: [token -= 1, gift += 1]
`,
      /resolve gift -> resolve token -> resolve gift/,
    ],
  ] as const)
    assert.throws(
      () => compile_yaml(base + body, termination, manifest, "draw_count"),
      cycle,
    );
});

test("allows acyclic nested draws and ignores calls after terminate", () => {
  const acyclic = `schema_version: 2
items: [draw_count, target, gift]
pools:
- main:
  - probability: 1
    actions: gift += 1
- nested:
  - probability: 1
    actions: target += 1
item_resolve:
- item: gift
  retain: 0
  actions: [gift -= 1, draw nested]
`;
  assert.doesNotThrow(() =>
    compile_yaml(acyclic, termination, manifest, "draw_count"),
  );
  assert.doesNotThrow(() =>
    compile_yaml(
      acyclic.replace(
        "actions: gift += 1",
        "actions: [terminate done, draw main]",
      ),
      termination,
      manifest,
      "draw_count",
    ),
  );
});

test("compiles a long acyclic resolver chain without overflowing the call stack", () => {
  const resolverCount = 10_000;
  const resolverItems = Array.from(
    { length: resolverCount },
    (_, index) => `i${index}`,
  );
  const source = `schema_version: 2
items: [draw_count, target, guard, ${resolverItems.join(", ")}]
pools:
- main:
  - probability: 1
    actions: i0 += 1
item_resolve:
${resolverItems
  .map(
    (item, index) => `- item: ${item}
  retain: 0
  actions: [${item} -= 1, ${resolverItems[index + 1] ?? "target"} += 1]`,
  )
  .join("\n")}
rules:
- bounded:
    mode: repeat
    condition: {check: guard >= 1, actions: [draw main, guard -= 1]}
`;
  assert.ok(Buffer.byteLength(source) < YAML_TEXT_LIMIT);
  assert.doesNotThrow(() =>
    compile_yaml(source, termination, manifest, "draw_count"),
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
