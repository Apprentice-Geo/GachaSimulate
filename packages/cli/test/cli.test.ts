import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";

const cli = resolve("dist/index.js");

function run(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

test("simulates fixed runs and analyzes the selected result item", async () => {
  const root = mkdtempSync(join(tmpdir(), "gachasimulate-cli-test-"));
  const config = join(root, "config");
  const temporary = join(root, "tmp");
  mkdirSync(config);
  mkdirSync(temporary);
  writeFileSync(
    join(config, "config.yaml"),
    `schema_version: 2
items: [draw_count, target]
pools:
  - main:
      - probability: 1
        actions: target += 1
initial: change main
every_draw: draw_count += 1
`,
  );
  writeFileSync(
    join(config, "termination.yaml"),
    `retained_items: []
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
terminations:
  - file: termination.yaml
    name: done
`,
  );
  const output = join(root, "fixed.gsr");
  const common = [
    "--config-dir",
    config,
    "--termination",
    "termination.yaml",
    "--result-item",
    "draw_count",
  ];
  assert.equal(
    run(["simulate", ...common, "--total-runs", "4", "--output", output], {
      TMPDIR: temporary,
    }).status,
    0,
  );
  const analyzed = run(["analyze", "--input", output]);
  assert.equal(analyzed.status, 0);
  const analysis = JSON.parse(analyzed.stdout);
  assert.deepEqual(analysis.result_item, {
    id: "draw_count",
    name: "draw_count",
  });
  assert.deepEqual(analysis.totals, { runs: "4", result: "4" });
  assert.deepEqual(analysis.values, ["1"]);
  assert.notEqual(
    run(["simulate", ...common, "--total-runs", "1", "--output", output])
      .status,
    0,
  );
  assert.notEqual(
    run(["analyze", "--input", output, "--metric", "draw"]).status,
    0,
  );
  assert.notEqual(
    run([
      "simulate",
      ...common,
      "--total-runs",
      "100000001",
      "--output",
      join(root, "too-many.gsr"),
    ]).status,
    0,
  );

  const interrupted_output = join(root, "interrupted.gsr");
  const interrupted = spawn(
    process.execPath,
    [
      cli,
      "simulate",
      ...common,
      "--total-runs",
      "100000000",
      "--output",
      interrupted_output,
    ],
    {
      env: { ...process.env, TMPDIR: temporary },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise<void>((resolve_promise, reject) => {
    interrupted.once("error", reject);
    interrupted.stdout.setEncoding("utf8");
    interrupted.stdout.on("data", (chunk: string) => {
      if (chunk.includes('"stage":"simulating"')) interrupted.kill("SIGTERM");
    });
    interrupted.once("close", () => resolve_promise());
  });
  assert.equal(existsSync(interrupted_output), false);

  const failed_output = join(root, "missing", "failed.gsr");
  assert.notEqual(
    run(["simulate", ...common, "--total-runs", "1", "--output", failed_output])
      .status,
    0,
  );
  assert.equal(existsSync(failed_output), false);
  assert.deepEqual(readdirSync(temporary), []);
});

test("analyzer failures keep stdout empty and diagnostics on stderr", () => {
  const root = mkdtempSync(join(tmpdir(), "gachasimulate-cli-invalid-"));
  const input = join(root, "bad.gsr");
  writeFileSync(input, "bad");
  const result = run(["analyze", "--input", input]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /invalid GSR/);
});
