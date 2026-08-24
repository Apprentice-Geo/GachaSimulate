import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { ResultEditor } from "./result_editor";

const analysis = {
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
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill() {
    return true;
  }
  close() {
    this.emit("close", 0);
  }
}
test("saves and restores DisplayConfig while analysis remains authoritative", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gachasimulate-result-test-"));
  const path = join(directory, "sample.gsr");
  writeFileSync(path, "fixture");
  const children: FakeChild[] = [];
  const editor = new ResultEditor({
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    random_uuid: () => "atomic",
  });
  try {
    const opening = editor.open(path);
    children[0].stdout.write(JSON.stringify(analysis));
    children[0].close();
    const opened = await opening;
    assert.equal(opened.analysis.result_item.id, "draw_count");
    assert.equal(opened.display.display_version, 2);
    assert.equal(opened.display.subtitle, "");
    assert.equal(opened.display.result_item_unit, "");
    const saved = editor.save({
      title: "标题",
      target: "目标",
      result_item_name: "代币",
      note: "",
      subtitle: "兑换结果",
      result_item_unit: "个",
    });
    assert.deepEqual(
      JSON.parse(readFileSync(saved.sidecar_path, "utf8")),
      saved.display,
    );
    assert.equal(saved.display.result_item_name, "代币");
    assert.equal(saved.display.display_version, 2);
    assert.equal("timestamp" in saved.display, false);

    const reopening = editor.open(path);
    children[1].stdout.write(JSON.stringify(analysis));
    children[1].close();
    const reopened = await reopening;
    assert.deepEqual(reopened.display, saved.display);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a v1 sidecar without overwriting it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gachasimulate-result-test-"));
  const path = join(directory, "sample.gsr");
  const sidecar_path = join(directory, "sample.visualize.json");
  const legacy_sidecar = `${JSON.stringify(
    {
      display_version: 1,
      title: "旧标题",
      target: "旧目标",
      result_item_name: "抽数",
      note: "",
      price: "",
      unit: "抽",
    },
    null,
    2,
  )}\n`;
  writeFileSync(path, "fixture");
  writeFileSync(sidecar_path, legacy_sidecar);
  const children: FakeChild[] = [];
  const editor = new ResultEditor({
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });
  try {
    const opening = editor.open(path);
    children[0].stdout.write(JSON.stringify(analysis));
    children[0].close();
    await assert.rejects(opening, /非法 sidecar/);
    assert.equal(readFileSync(sidecar_path, "utf8"), legacy_sidecar);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
