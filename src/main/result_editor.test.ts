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
import type { AnalysisV2 } from "../visualize/types/analysis";
import { ResultEditor } from "./result_editor";

const analysis: AnalysisV2 = {
  analysis_version: 2,
  result_item: { id: "draw_count", name: "抽数" },
  totals: { runs: "2", result: "3" },
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
  value: AnalysisV2 = analysis,
) {
  child.stdout.write(JSON.stringify(value));
  child.close(0);
  return promise;
}

test("uses the v2 analyzer and saves a complete single sidecar", async () => {
  const value = fixture();
  try {
    const state = await complete(
      value.editor.open(value.path),
      value.children[0],
    );
    assert.equal(
      value.calls[0].command,
      resolve("build/native/bin/gachasimulate-analyze"),
    );
    assert.deepEqual(value.calls[0].args, ["--input", value.path]);
    assert.deepEqual(state.input, {
      title: "期末数量分布",
      target: "未设置",
      result_item: { id: "draw_count", name: "抽数" },
      total: 3,
      note: "MEAN 受极端值影响，P50 表示一半结果不超过该值，P95 表示 95% 结果不超过该值。MIN、MAX 受模拟次数影响，不代表理论极限。",
      statistic: {
        P5: 1,
        P25: 1,
        P50: 1,
        P75: 1,
        P95: 1,
        MIN: 1,
        MEAN: 1,
        MEAN_LEVEL: 0.5,
        MAX: 2,
      },
      termination_reason: [{ reason: "done", proportion: 100 }],
      timestamp: state.input.timestamp,
      values: [1, 2],
      cumulative: [0.5, 1],
      price: "",
      unit: "",
    });
    const fields = {
      title: "自定义标题",
      target: "获得目标",
      note: "备注",
      price: "10",
      unit: "元",
    };
    const saved = value.editor.save(fields);
    const document = JSON.parse(readFileSync(saved.sidecar_path, "utf8"));
    assert.deepEqual(document.result_item, { id: "draw_count", name: "抽数" });
    assert.deepEqual(document.values, [1, 2]);
    assert.deepEqual(saved.input, document);
    assert.equal(
      saved.sidecar_path,
      value.path.replace(/\.gsr$/, ".visualize.json"),
    );
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("restores display fields while preserving authoritative analysis and bad sidecars", async () => {
  const value = fixture();
  try {
    await complete(value.editor.open(value.path), value.children[0]);
    const saved = value.editor.save({
      title: "保留",
      target: "目标",
      note: "说明",
      price: "",
      unit: "",
    });
    const sidecar = saved.sidecar_path;
    const reopened = fixture();
    rmSync(reopened.path);
    reopened.path = value.path;
    const state = await complete(
      reopened.editor.open(value.path),
      reopened.children[0],
      { ...analysis, totals: { runs: "2", result: "7" } },
    );
    assert.equal(state.fields.title, "保留");
    assert.equal(state.input.total, 7);
    assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).total, 3);

    writeFileSync(sidecar, "{broken");
    const invalid = reopened.editor.open(value.path);
    reopened.children[1].stdout.write(JSON.stringify(analysis));
    reopened.children[1].close(0);
    await assert.rejects(invalid, /非法 sidecar/);
    assert.equal(readFileSync(sidecar, "utf8"), "{broken");
    rmSync(reopened.directory, { recursive: true, force: true });
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("rejects invalid and oversized analyzer JSON without writing a sidecar", async () => {
  const value = fixture();
  try {
    const invalid = value.editor.open(value.path);
    value.children[0].stdout.write("{broken");
    value.children[0].close(0);
    await assert.rejects(invalid);

    const oversized = value.editor.open(value.path);
    value.children[1].stdout.write("x".repeat(16 * 1024 * 1024 + 1));
    value.children[1].close(0);
    await assert.rejects(oversized, /exceeds 16 MiB/);
    assert.equal(
      existsSync(value.path.replace(/\.gsr$/, ".visualize.json")),
      false,
    );
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});
