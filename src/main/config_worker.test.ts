import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConfigWorkerClient,
  type ConfigWorkerThread,
} from "./config_worker_client";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
class FakeWorker extends EventEmitter {
  messages: Array<{ id: number }> = [];
  post_error = false;
  termination = async () => 0;
  terminations = 0;
  postMessage(value: { id: number }): void {
    if (this.post_error) throw new Error("postMessage failed");
    this.messages.push(value);
  }
  terminate(): Promise<number> {
    this.terminations += 1;
    return this.termination();
  }
  ref(): void {}
  unref(): void {}
  reply(value: unknown = undefined): void {
    this.emit("message", { id: this.messages.at(-1)!.id, ok: true, value });
  }
}

test("real source worker scans, compiles, stops and resumes without stale requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gachasimulate-worker-"));
  const installed = join(directory, "installed");
  const local = join(directory, "local");
  mkdirSync(installed);
  mkdirSync(local);
  cpSync("test-fixtures/configs/test", join(local, "test"), {
    recursive: true,
  });
  const client = new ConfigWorkerClient();
  try {
    const snapshot = await client.request("scan", {
      installed_dir: installed,
      local_dir: local,
    });
    assert.equal(snapshot.local[0]?.config.id, "test");
    const program = await client.request("compile", {
      directory: join(local, "test"),
      id: "test",
      source: "local",
      termination: "termination.yaml",
      result_item: "draw_count",
    });
    assert.ok(program.ir);
    await client.stop();
    await assert.rejects(
      client.request("scan", { installed_dir: installed, local_dir: local }),
      /shutdown/,
    );
    client.resume();
    assert.equal(
      (
        await client.request("scan", {
          installed_dir: installed,
          local_dir: local,
        })
      ).local.length,
      1,
    );
  } finally {
    await client.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("worker error rejects all pending requests and recovery waits for the retired worker", async () => {
  const first = new FakeWorker();
  const second = new FakeWorker();
  const retiring = deferred<number>();
  first.termination = () => retiring.promise;
  let created = 0;
  const client = new ConfigWorkerClient(
    () => (++created === 1 ? first : second) as unknown as ConfigWorkerThread,
  );
  const a = client.request("invalidate", undefined);
  const b = client.request("invalidate", undefined);
  const rejected_a = assert.rejects(a, /worker crashed/);
  const rejected_b = assert.rejects(b, /worker crashed/);
  first.emit("error", new Error("worker crashed"));
  await Promise.all([rejected_a, rejected_b]);
  const recovery = client.request("invalidate", undefined);
  await tick();
  assert.equal(created, 1);
  retiring.resolve(1);
  await tick();
  assert.equal(created, 2);
  first.emit("exit", 1);
  second.reply();
  await recovery;
  await client.stop();
});

test("failed retirement retains one owner and never creates workers without bound", async () => {
  const first = new FakeWorker();
  first.post_error = true;
  first.termination = async () => {
    throw new Error("termination blocked");
  };
  const second = new FakeWorker();
  let created = 0;
  const client = new ConfigWorkerClient(
    () => (++created === 1 ? first : second) as unknown as ConfigWorkerThread,
  );
  await assert.rejects(
    client.request("invalidate", undefined),
    /postMessage failed/,
  );
  for (let index = 0; index < 3; index += 1)
    await assert.rejects(
      client.request("invalidate", undefined),
      /termination blocked/,
    );
  assert.equal(created, 1);
  await assert.rejects(client.stop(), /termination blocked/);
  client.resume();
  await assert.rejects(
    client.request("invalidate", undefined),
    /termination blocked/,
  );
  assert.equal(created, 1);
  first.emit("exit", 1);
  const recovered = client.request("invalidate", undefined);
  second.reply();
  await recovered;
  assert.equal(created, 2);
  await client.stop();
});

test("shutdown waits for retired threads and prevents new queries until recovery", async () => {
  const worker = new FakeWorker();
  const retirement = deferred<number>();
  worker.termination = () => retirement.promise;
  const client = new ConfigWorkerClient(
    () => worker as unknown as ConfigWorkerThread,
  );
  const query = client.request("invalidate", undefined);
  const rejected = assert.rejects(query, /failed/);
  worker.emit("error", new Error("failed"));
  await rejected;
  let stopped = false;
  const stopping = client.stop().then(() => {
    stopped = true;
  });
  await tick();
  assert.equal(stopped, false);
  await assert.rejects(client.request("invalidate", undefined), /shutdown/);
  assert.throws(() => client.resume(), /still stopping/);
  retirement.resolve(0);
  await stopping;
  assert.equal(worker.terminations, 1);
});

test("a never-returning termination times out without losing its owner or duplicating termination", async () => {
  const worker = new FakeWorker();
  worker.termination = () => new Promise<number>(() => undefined);
  const client = new ConfigWorkerClient(
    () => worker as unknown as ConfigWorkerThread,
    10,
  );
  const query = client.request("invalidate", undefined);
  const rejected = assert.rejects(query, /shutdown/);
  await assert.rejects(client.stop(), /worker exit timed out/);
  await rejected;
  await assert.rejects(client.stop(), /worker exit timed out/);
  assert.equal(worker.terminations, 1);
  worker.emit("exit", 0);
  await client.stop();
  assert.equal(worker.terminations, 1);
  client.resume();
});
