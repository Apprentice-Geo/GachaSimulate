import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { SimulationTask } from "./simulation";
import {
  parse_simulation_line,
  resolve_process_outcome,
  type DesktopSimulationEvent,
  validate_simulation_request,
} from "../shared/simulation";

const request = {
  configId: "test",
  termination: "termination.yaml",
  target: { kind: "totalRuns" as const, value: 1 },
  seed: 0,
  workers: 1,
  metric: "draw" as const,
};

class FakeChild extends EventEmitter {
  readonly pid = 123;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    return true;
  }

  close(code: number | null = null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

function create_task(
  terminate: (child: ChildProcess) => Promise<void>,
  close_timeout_ms = 100,
) {
  const child = new FakeChild();
  const events: DesktopSimulationEvent[] = [];
  const task = new SimulationTask(
    resolve("configs"),
    resolve("results"),
    (event) => events.push(event),
    {
      spawn: () => child as unknown as ChildProcess,
      terminate_process_tree: terminate,
      close_timeout_ms,
    },
  );
  task.start(request);
  child.stdout.write('{"type":"started"}\n');
  return { child, events, task };
}

test("validates exclusive positive targets and worker limit", () => {
  validate_simulation_request(request, 2);
  assert.throws(() =>
    validate_simulation_request({ ...request, workers: 3 }, 2),
  );
  assert.throws(() =>
    validate_simulation_request(
      { ...request, target: { kind: "totalRuns", value: 0 } },
      2,
    ),
  );
});

test("parses JSONL and ignores unknown events", () => {
  const diagnostics: string[] = [];
  assert.equal(parse_simulation_line("", diagnostics), null);
  assert.deepEqual(
    parse_simulation_line(
      '{"type":"progress","completed":1,"total":2,"unit":"runs"}',
    ),
    {
      type: "progress",
      completed: 1,
      total: 2,
      unit: "runs",
    },
  );
  assert.equal(parse_simulation_line('{"type":"future"}', diagnostics), null);
  assert.deepEqual(diagnostics, ["unknown event type: future"]);
  assert.throws(() => parse_simulation_line("not json"));
  assert.throws(() => parse_simulation_line('{"type":"completed"}'));
});

test("resolves process outcomes", () => {
  assert.equal(resolve_process_outcome(0, true, false, false), "completed");
  assert.equal(resolve_process_outcome(1, false, true, false), "failed");
  assert.equal(resolve_process_outcome(0, false, false, false), "failed");
  assert.equal(resolve_process_outcome(null, false, false, true), "cancelled");
});

test("cancels only after the child closes", async () => {
  const { child, events, task } = create_task(async () => {});

  const cancelling = task.cancel();
  assert.equal(events.at(-1)?.status, "cancelling");
  assert.equal(task.active, true);

  child.close(null, "SIGTERM");
  await cancelling;
  assert.equal(events.at(-1)?.status, "cancelled");
  assert.equal(task.active, false);
});

test("failed termination restores the active state and allows retry", async () => {
  let attempts = 0;
  const { child, events, task } = create_task(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("access denied");
  });

  await assert.rejects(task.cancel(), /access denied/);
  assert.equal(events.at(-1)?.status, "running");
  assert.equal(task.active, true);

  const retry = task.cancel();
  child.close(null, "SIGTERM");
  await retry;
  assert.equal(events.at(-1)?.status, "cancelled");
});

test("child close wins when termination reports an error", async () => {
  const { events, task } = create_task(async (child) => {
    (child as unknown as FakeChild).close(null, "SIGTERM");
    throw new Error("already gone");
  });

  await task.cancel();
  assert.equal(events.at(-1)?.status, "cancelled");
  assert.equal(task.active, false);
});

test("close timeout restores a retryable active state", async () => {
  const { events, task } = create_task(async () => {}, 5);

  await assert.rejects(task.cancel(), /timed out/);
  assert.equal(events.at(-1)?.status, "running");
  assert.equal(task.active, true);
});

test("invalid JSONL keeps the task active until close then fails", async () => {
  let terminate_calls = 0;
  const { child, events, task } = create_task(async () => {
    terminate_calls += 1;
  });

  child.stdout.write("not json\n");
  await Promise.resolve();
  assert.equal(terminate_calls, 1);
  assert.equal(events.at(-1)?.status, "cancelling");
  assert.equal(task.active, true);
  assert.throws(() => task.start(request), /already running/);

  child.close(1);
  assert.equal(events.at(-1)?.status, "failed");
  assert.equal(events.at(-1)?.message, "invalid JSONL event");
  assert.equal(task.active, false);
});

test("Python error event becomes terminal only after close", () => {
  const { child, events, task } = create_task(async () => {});

  child.stdout.write('{"type":"error","message":"bad config"}\n');
  assert.equal(events.at(-1)?.status, "running");
  assert.equal(events.at(-1)?.message, "bad config");
  assert.equal(task.active, true);

  child.close(1);
  assert.equal(events.at(-1)?.status, "failed");
  assert.equal(events.at(-1)?.message, "bad config");
});
