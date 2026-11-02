import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  ANALYSIS_JSON_BYTE_LIMIT,
  DISPLAY_CONFIG_JSON_BYTE_LIMIT,
  ResultEditor,
} from "./result_editor";

const analysis = {
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
  let uuid = 0;
  const editor = new ResultEditor({
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    random_uuid: () => `id-${++uuid}`,
  });
  try {
    const opening = editor.open(path);
    children[0].stdout.write(JSON.stringify(analysis));
    children[0].close();
    const opened = await opening;
    assert.equal(opened.analysis.result_item.id, "draw_count");
    assert.equal(opened.display.display_version, 2);
    assert.deepEqual(opened.display, {
      display_version: 2,
      title: "标题待填写",
      target: "目标待填写",
      result_item_name: analysis.result_item.name,
      note: "MEAN 受极端值影响，P50 表示一半结果不超过该值，P95 表示 95% 结果不超过该值。MIN、MAX 受模拟次数影响，不代表理论极限。",
      subtitle: "副标题待填写",
      result_item_unit: "",
    });
    assert.equal(opened.display.result_item_unit, "");
    const saved = await editor.save({
      session_id: opened.session_id,
      fields: {
        title: "标题",
        target: "目标",
        result_item_name: "代币",
        note: "",
        subtitle: "兑换结果",
        result_item_unit: "个",
      },
    });
    assert.deepEqual(
      JSON.parse(readFileSync(saved.sidecar_path, "utf8")),
      saved.display,
    );
    assert.equal(saved.display.result_item_name, "代币");
    assert.equal(saved.display.display_version, 2);
    assert.equal("timestamp" in saved.display, false);
    const snapshot = await editor.snapshot(opened.session_id);
    assert.deepEqual(snapshot.analysis, opened.analysis);
    assert.notEqual(snapshot.analysis, opened.analysis);
    assert.deepEqual(snapshot.display, saved.display);

    const reopening = editor.open(path);
    children[1].stdout.write(JSON.stringify(analysis));
    children[1].close();
    const reopened = await reopening;
    assert.deepEqual(reopened.display, saved.display);
    assert.notEqual(reopened.session_id, opened.session_id);
    await assert.rejects(
      editor.save({ session_id: opened.session_id, fields: saved.fields }),
      /session has changed/,
    );
    assert.deepEqual(snapshot.display, saved.display);
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

test("accepts one analyzer newline frame and enforces the JSON byte limit", async () => {
  assert.equal(ANALYSIS_JSON_BYTE_LIMIT, 64 * 1024 * 1024);
  assert.equal(DISPLAY_CONFIG_JSON_BYTE_LIMIT, 16 * 1024 * 1024);
  const directory = mkdtempSync(
    join(tmpdir(), "gachasimulate-result-limit-test-"),
  );
  const path = join(directory, "sample.gsr");
  writeFileSync(path, "fixture");
  const serialized = JSON.stringify(analysis);

  try {
    for (const newline of ["\n", "\r\n"]) {
      const children: FakeChild[] = [];
      const editor = new ResultEditor({
        analysis_json_byte_limit: Buffer.byteLength(serialized),
        spawn: () => {
          const child = new FakeChild();
          children.push(child);
          return child as unknown as ChildProcess;
        },
      });
      const opening = editor.open(path);
      children[0].stdout.write(`${serialized}${newline}`);
      children[0].close();
      assert.deepEqual((await opening).analysis, analysis);
    }

    const children: FakeChild[] = [];
    const editor = new ResultEditor({
      analysis_json_byte_limit: Buffer.byteLength(serialized),
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });
    const opening = editor.open(path);
    children[0].stdout.write(`${serialized} \n`);
    children[0].close();
    await assert.rejects(opening, /analyzer JSON exceeds 64 MiB/);

    let terminated = 0;
    const oversized_children: FakeChild[] = [];
    const oversized_editor = new ResultEditor({
      analysis_json_byte_limit: Buffer.byteLength(serialized),
      spawn: () => {
        const child = new FakeChild();
        oversized_children.push(child);
        return child as unknown as ChildProcess;
      },
      terminate_native_process: async (child) => {
        terminated += 1;
        (child as unknown as FakeChild).close();
      },
    });
    const oversized_opening = oversized_editor.open(path);
    oversized_children[0].stdout.write(`${serialized}   `);
    await assert.rejects(oversized_opening, /analyzer JSON exceeds 64 MiB/);
    assert.equal(terminated, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function analyzer_fixture(
  options: ConstructorParameters<typeof ResultEditor>[0] = {},
) {
  const children: FakeChild[] = [];
  const editor = new ResultEditor({
    ...options,
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });
  return { editor, children };
}

test("rejects an unrenderable candidate while retaining the last valid session", async () => {
  const { editor, children } = analyzer_fixture();
  const path = join(tmpdir(), "valid.gsr");
  const first = editor.open(path);
  children[0].stdout.write(JSON.stringify(analysis));
  children[0].close();
  const valid = await first;
  const invalid = editor.open(join(tmpdir(), "invalid.gsr"));
  children[1].stdout.write(
    JSON.stringify({
      ...analysis,
      totals: { ...analysis.totals, result: "9007199254740992" },
    }),
  );
  children[1].close();
  await assert.rejects(invalid, /supported visualization range/);
  assert.equal(
    (await editor.snapshot(valid.session_id)).session_id,
    valid.session_id,
  );
  const retry = editor.open(path);
  children[2].stdout.write(JSON.stringify(analysis));
  children[2].close();
  assert.notEqual((await retry).session_id, valid.session_id);
});

test("analyzer concurrent cancellation is bounded and retains a retry owner", async () => {
  let terminations = 0;
  const { editor, children } = analyzer_fixture({
    close_timeout_ms: 10,
    terminate_native_process: async () => {
      terminations += 1;
    },
  });
  const opening = editor.open(join(tmpdir(), "cancel.gsr"));
  const rejected = assert.rejects(opening, /cancelled/);
  const first = editor.cancel();
  const second = editor.cancel();
  await Promise.all([
    assert.rejects(first, /close timed out/),
    assert.rejects(second, /close timed out/),
  ]);
  assert.equal(terminations, 1);
  assert.equal(editor.active, true);
  const retry = editor.cancel();
  children[0].stdout.write(JSON.stringify(analysis));
  children[0].close();
  await retry;
  await rejected;
  assert.equal(terminations, 2);
  assert.equal(editor.active, false);
  const next = editor.open(join(tmpdir(), "next.gsr"));
  children[1].stdout.write(JSON.stringify(analysis));
  children[1].close();
  await next;
});

test("analyzer close wins a termination error race without committing cancelled input", async () => {
  const { editor, children } = analyzer_fixture({
    terminate_native_process: async () => {
      children[0].stdout.write(JSON.stringify(analysis));
      children[0].close();
      throw new Error("already exited");
    },
  });
  const opening = editor.open(join(tmpdir(), "race.gsr"));
  const rejected = assert.rejects(opening, /cancelled/);
  await editor.cancel();
  await rejected;
  assert.equal(editor.active, false);
});

test("output overflow locks one stop decision and preserves its original failure", async () => {
  let terminations = 0;
  const { editor, children } = analyzer_fixture({
    analysis_json_byte_limit: 10,
    close_timeout_ms: 10,
    terminate_native_process: async () => {
      terminations += 1;
      throw new Error("blocked");
    },
  });
  const opening = editor.open(join(tmpdir(), "overflow.gsr"));
  const rejected = assert.rejects(opening, /JSON exceeds/);
  children[0].stdout.write("x".repeat(20));
  await new Promise<void>((done) => setImmediate(done));
  children[0].stdout.write("more");
  children[0].stdout.write("more");
  assert.equal(terminations, 1);
  assert.equal(editor.active, true);
  children[0].close();
  await rejected;
});

test("rechecks admission after analysis before committing a new session", async () => {
  const { editor, children } = analyzer_fixture({
    assert_open_allowed: () => {
      throw new Error("application is shutting down");
    },
  });
  const opening = editor.open(join(tmpdir(), "pending.gsr"));
  children[0].stdout.write(JSON.stringify(analysis));
  children[0].close();
  await assert.rejects(opening, /shutting down/);
});

test("a new analyzer owns its cancellation while an old termination still returns", async () => {
  let finish_old!: () => void;
  let terminations = 0;
  const { editor, children } = analyzer_fixture({
    terminate_native_process: async () => {
      terminations += 1;
      if (terminations === 1)
        await new Promise<void>((resolve) => {
          finish_old = resolve;
        });
      else children[1].close();
    },
  });
  const old = editor.open(join(tmpdir(), "old.gsr"));
  const old_rejected = assert.rejects(old, /cancelled/);
  const cancelling_old = editor.cancel();
  children[0].close();
  await old_rejected;
  const next = editor.open(join(tmpdir(), "new.gsr"));
  const next_rejected = assert.rejects(next, /cancelled/);
  await editor.cancel();
  await next_rejected;
  assert.equal(terminations, 2);
  finish_old();
  await cancelling_old;
  assert.equal(editor.active, false);
});
