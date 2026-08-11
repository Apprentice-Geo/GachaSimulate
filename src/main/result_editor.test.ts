import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import type { AnalysisV1 } from "../visualize/types/analysis";
import { ResultEditor } from "./result_editor";

const analysis: AnalysisV1 = {
  analysis_version: 1,
  metric: "draw",
  totals: { runs: "2", draw: "3", cost: "9" },
  values: ["1", "2"],
  cumulative: [0.5, 1],
  statistic: {
    P5: "1",
    P25: "1",
    P50: "1",
    P75: "1",
    P95: "1",
    MIN: "1",
    MEAN: "1",
    MEAN_LEVEL: 0.5,
    MAX: "2",
  },
  termination_reason: [{ reason: "done", proportion: 100 }],
};

class FakeChild extends EventEmitter {
  readonly pid = 456;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    return true;
  }
  close(code: number | null = 0) {
    this.exitCode = code;
    this.emit("close", code);
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gachasimulate-result-test-"));
  const path = join(directory, "sample.gsr");
  writeFileSync(path, "fixture");
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  const editor = new ResultEditor({
    spawn: (command, args) => {
      const child = new FakeChild();
      children.push(child);
      calls.push({ command, args });
      return child as unknown as ChildProcess;
    },
    random_uuid: () => "atomic",
  });
  return { calls, children, directory, editor, path };
}

async function complete(
  promise: ReturnType<ResultEditor["open"]>,
  child: FakeChild,
  value: AnalysisV1 = analysis,
) {
  child.stdout.write(JSON.stringify(value));
  child.close(0);
  return promise;
}

test("uses the trusted analyzer for draw/cost and saves a complete sidecar", async () => {
  const value = fixture();
  try {
    await complete(value.editor.open(value.path, "draw"), value.children[0]);
    assert.equal(
      value.calls[0].command,
      resolve("build/native/bin/gachasimulate-analyze"),
    );
    assert.deepEqual(value.calls[0].args, [
      "--input",
      value.path,
      "--metric",
      "draw",
    ]);
    const fields = {
      title: "自定义标题",
      target: "获得目标",
      note: "备注",
      price: "10",
      unit: "元",
    };
    const saved = value.editor.save(fields);
    const document = JSON.parse(readFileSync(saved.sidecar_path, "utf8"));
    assert.equal(document.title, fields.title);
    assert.equal(document.metric, "draw");
    assert.deepEqual(document.values, [1, 2]);

    const cost = value.editor.switch_metric("cost");
    const cost_state = await complete(cost, value.children[1], {
      ...analysis,
      metric: "cost",
    });
    assert.equal(cost_state.metric, "cost");
    await assert.rejects(value.editor.switch_metric("item"), /invalid metric/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("restores only display fields and preserves invalid sidecars/analyzer errors", async () => {
  const value = fixture();
  try {
    const sidecar = value.path.replace(/\.gsr$/, ".draw.visualize.json");
    await complete(value.editor.open(value.path, "draw"), value.children[0]);
    const saved = value.editor.save({
      title: "保留",
      target: "目标",
      note: "说明",
      price: "",
      unit: "",
    });
    const document = JSON.parse(readFileSync(saved.sidecar_path, "utf8"));
    document.total = 999;
    writeFileSync(sidecar, JSON.stringify(document));
    const reopened = fixture();
    rmSync(reopened.path);
    reopened.path = value.path;
    const state = await complete(
      reopened.editor.open(value.path, "draw"),
      reopened.children[0],
      { ...analysis, totals: { ...analysis.totals, draw: "7" } },
    );
    assert.equal(state.fields.title, "保留");

    writeFileSync(sidecar, "{broken");
    const invalid = reopened.editor.open(value.path, "draw");
    reopened.children[1].stdout.write(JSON.stringify(analysis));
    reopened.children[1].close(0);
    await assert.rejects(invalid, /非法 draw sidecar/);
    assert.equal(readFileSync(sidecar, "utf8"), "{broken");

    const failure = reopened.editor.switch_metric("cost");
    reopened.children[2].stderr.write("GSR has no cost section");
    reopened.children[2].close(1);
    await assert.rejects(failure, /no cost section/);
    assert.equal(existsSync(sidecar), true);
    rmSync(reopened.directory, { recursive: true, force: true });
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("rejects invalid and oversized analyzer JSON", async () => {
  const value = fixture();
  try {
    const invalid = value.editor.open(value.path, "draw");
    value.children[0].stdout.write("{broken");
    value.children[0].close(0);
    await assert.rejects(invalid);

    const oversized = value.editor.open(value.path, "draw");
    value.children[1].stdout.write("x".repeat(16 * 1024 * 1024 + 1));
    value.children[1].close(0);
    await assert.rejects(oversized, /exceeds 16 MiB/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});
