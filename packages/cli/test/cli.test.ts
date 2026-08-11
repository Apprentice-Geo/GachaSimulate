import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const cli = resolve("dist/index.js");

function run(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

test("simulates both targets, analyzes draw/cost, rejects overwrite and cleans temporary IR", () => {
  const root = mkdtempSync(join(tmpdir(), "gachasimulate-cli-test-"));
  const config = join(root, "config");
  const temporary = join(root, "tmp");
  mkdirSync(config);
  mkdirSync(temporary);
  writeFileSync(
    join(config, "config.yaml"),
    `schema_version: 1
items: [target, cost_count]
pools:
  - main:
      - probability: 1
        actions: target += 1
initial: change main
every_draw: cost_count += 10
`,
  );
  writeFileSync(
    join(config, "termination.yaml"),
    `retained_items:
  - target: 1
termination_rule:
  condition:
    check: target >= 1
    actions: terminate done
`,
  );
  writeFileSync(
    join(config, "manifest.yaml"),
    `id: test
name: test
description: test
metrics: [draw, cost]
terminations:
  - file: termination.yaml
    name: done
`,
  );
  const fixed = join(root, "fixed.gsr");
  const target = join(root, "target.gsr");
  const common = ["--config-dir", config, "--termination", "termination.yaml"];
  assert.equal(
    run(["simulate", ...common, "--total-runs", "4", "--output", fixed], {
      TMPDIR: temporary,
    }).status,
    0,
  );
  assert.equal(
    run(
      ["simulate", ...common, "--target-total-draw", "4", "--output", target],
      { TMPDIR: temporary },
    ).status,
    0,
  );
  const draw = run(["analyze", "--input", fixed, "--metric", "draw"]);
  const cost = run(["analyze", "--input", fixed, "--metric", "cost"]);
  assert.equal(draw.status, 0);
  assert.equal(cost.status, 0);
  assert.equal(JSON.parse(draw.stdout).totals.draw, "4");
  assert.deepEqual(JSON.parse(cost.stdout).values, ["10"]);
  assert.notEqual(
    run(["simulate", ...common, "--total-runs", "1", "--output", fixed]).status,
    0,
  );
  assert.deepEqual(readdirSync(temporary), []);
});

test("analyzer failures keep stdout empty and diagnostics on stderr", () => {
  const root = mkdtempSync(join(tmpdir(), "gachasimulate-cli-invalid-"));
  const input = join(root, "bad.gsr");
  writeFileSync(input, "bad");
  const result = run(["analyze", "--input", input, "--metric", "draw"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /invalid GSR/);
});
