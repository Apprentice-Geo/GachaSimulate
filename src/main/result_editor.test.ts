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
    const saved = editor.save({
      title: "标题",
      target: "目标",
      result_item_name: "代币",
      note: "",
      price: "",
      unit: "个",
    });
    assert.deepEqual(
      JSON.parse(readFileSync(saved.sidecar_path, "utf8")),
      saved.display,
    );
    assert.equal(saved.display.result_item_name, "代币");
    assert.equal("timestamp" in saved.display, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
