import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compile_yaml } from "@gachasimulate/config-compiler";

test("runs YAML through the native simulation and analysis pipeline", (context) => {
  const temporary = mkdtempSync(join(tmpdir(), "gachasimulate-pipeline-"));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));

  const ir = join(temporary, "program.json");
  const result = join(temporary, "result.gsr");
  writeFileSync(
    ir,
    JSON.stringify(
      compile_yaml(
        `schema_version: 2
items: [{draw_count: 抽数}, target]
pools:
  - main:
      - probability: 1
        actions: target += 1
every_draw: draw_count += 1
`,
        `retained_items: []
termination_rule:
  condition:
    check: target >= 1
    actions: terminate done
`,
        `id: pipeline
name: Pipeline
description: Native pipeline test
terminations:
  - file: termination.yaml
    name: Done
`,
        "draw_count",
      ).ir,
    ),
  );

  const suffix = process.platform === "win32" ? ".exe" : "";
  const core = spawnSync(
    resolve(`build/native/bin/gachasimulate-core${suffix}`),
    [
      "--ir",
      ir,
      "--total-runs",
      "4",
      "--seed",
      "0",
      "--threads",
      "1",
      "--output",
      result,
    ],
    { encoding: "utf8" },
  );
  assert.equal(core.status, 0, core.stderr);

  const analyzed = spawnSync(
    resolve(`build/native/bin/gachasimulate-analyze${suffix}`),
    ["--input", result],
    { encoding: "utf8" },
  );
  assert.equal(analyzed.status, 0, analyzed.stderr);
  const analysis = JSON.parse(analyzed.stdout);
  assert.equal(analysis.analysis_version, 2);
  assert.deepEqual(analysis.result_item, { id: "draw_count", name: "抽数" });
  assert.equal(analysis.totals.runs, "4");
});
