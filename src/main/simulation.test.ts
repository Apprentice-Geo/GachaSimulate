import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { shutdown_native_processes, SimulationTask } from "./simulation";
import {
  parse_simulation_line,
  resolve_process_outcome,
  type DesktopSimulationEvent,
  validate_simulation_request,
} from "../shared/simulation";

const request = {
  configSource: "local" as const,
  configId: "test",
  termination: "termination.yaml",
  resultItem: "draw_count",
  target: { kind: "totalRuns" as const, value: 1 },
  seed: 0,
  threads: 1,
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
  let command = "";
  let args: string[] = [];
  const task = new SimulationTask(
    resolve("test-fixtures/configs"),
    resolve("results"),
    (event) => events.push(event),
    {
      spawn: (next_command, next_args) => {
        command = next_command;
        args = next_args;
        return child as unknown as ChildProcess;
      },
      terminate_native_process: terminate,
      close_timeout_ms,
      local_dir: () => resolve("test-fixtures/configs"),
    },
  );
  task.start(request);
  child.stdout.write('{"type":"started"}\n');
  return { args, child, command, events, task };
}

test("validates strict requests, positive targets, and thread limit", () => {
  validate_simulation_request(request, 2);
  assert.throws(() =>
    validate_simulation_request({ ...request, threads: 3 }, 2),
  );
  assert.throws(() =>
    validate_simulation_request({ ...request, workers: 1 }, 2),
  );
  assert.throws(() =>
    validate_simulation_request({ ...request, metric: "draw" }, 2),
  );
  assert.throws(() =>
    validate_simulation_request({ ...request, configSource: "remote" }, 2),
  );
  assert.throws(() =>
    validate_simulation_request({ ...request, downloadUrl: "https://bad" }, 2),
  );
  assert.throws(() =>
    validate_simulation_request({ ...request, resultItem: "not-an-id" }, 2),
  );
  assert.throws(() =>
    validate_simulation_request(
      { ...request, target: { kind: "totalRuns", value: 0 } },
      2,
    ),
  );
  assert.throws(() =>
    validate_simulation_request(
      { ...request, target: { kind: "totalRuns", value: 100_000_001 } },
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

test("starts local and installed configs with the same id by source", () => {
  const root = mkdtempSync(join(tmpdir(), "gachasimulate-sources-"));
  try {
    cpSync(
      resolve("test-fixtures/configs/test"),
      join(root, "installed", "test"),
      { recursive: true },
    );
    writeFileSync(
      join(root, "installed", "test", ".gachasimulate.json"),
      JSON.stringify({ sha256: "0".repeat(64) }),
    );
    for (const configSource of ["local", "installed"] as const) {
      const child = new FakeChild();
      const task = new SimulationTask(
        join(root, "installed"),
        join(root, "results"),
        () => {},
        {
          local_dir: () => resolve("test-fixtures/configs"),
          spawn: () => child as unknown as ChildProcess,
        },
      );
      task.start({ ...request, configSource });
      assert.equal(task.active, true);
      child.close(1);
      assert.equal(task.active, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("assembles chunked JSONL and rejects oversized complete or partial lines once", async () => {
  const normal = create_task(async () => {});
  normal.child.stdout.write('{"type":"pro');
  normal.child.stdout.write('gress","completed":1,"total":1,"unit":"runs"}\n');
  assert.equal(normal.events.at(-1)?.event?.type, "progress");
  normal.child.close(1);

  for (const chunks of [
    ["x".repeat(64 * 1024 + 1), "\n"],
    ["x".repeat(32 * 1024), "x".repeat(32 * 1024 + 1)],
  ]) {
    let terminate_calls = 0;
    const value = create_task(async () => {
      terminate_calls += 1;
    });
    const output = value.args.at(-1)!;
    writeFileSync(output, "partial");
    for (const chunk of chunks) value.child.stdout.write(chunk);
    await Promise.resolve();
    assert.equal(terminate_calls, 1);
    value.child.close(1);
    assert.equal(
      value.events.at(-1)?.message,
      "core JSONL line exceeds 64 KiB",
    );
    assert.equal(existsSync(output), false);
  }
});

test("protocol termination failure remains retryable and preserves the protocol error", async () => {
  let terminate_calls = 0;
  const { child, events, task } = create_task(async () => {
    terminate_calls += 1;
    if (terminate_calls === 1) throw new Error("access denied");
  });

  child.stdout.write("not json\n");
  await Promise.resolve();
  assert.equal(events.at(-1)?.status, "running");
  assert.equal(events.at(-1)?.message, "access denied");
  assert.equal(task.active, true);

  const retry = task.cancel();
  child.close(1);
  await retry;
  assert.equal(terminate_calls, 2);
  assert.equal(events.at(-1)?.status, "failed");
  assert.equal(events.at(-1)?.message, "invalid JSONL event");
  assert.equal(task.active, false);
});

test("core error event becomes terminal only after close", () => {
  const { child, events, task } = create_task(async () => {});

  child.stdout.write('{"type":"error","message":"bad config"}\n');
  assert.equal(events.at(-1)?.status, "running");
  assert.equal(events.at(-1)?.message, "bad config");
  assert.equal(task.active, true);

  child.close(1);
  assert.equal(events.at(-1)?.status, "failed");
  assert.equal(events.at(-1)?.message, "bad config");
});

test("requires a matching terminal event and exit code", () => {
  const cases = [
    { line: "completed", code: 0, status: "completed" },
    { line: "completed", code: 1, status: "failed" },
    {
      line: '{"type":"error","message":"bad config"}',
      code: 0,
      status: "failed",
    },
    { line: null, code: 0, status: "failed" },
    { line: null, code: 1, status: "failed" },
  ] as const;

  for (const scenario of cases) {
    const { args, child, events } = create_task(async () => {});
    if (scenario.line === "completed")
      child.stdout.write(
        `${JSON.stringify({
          type: "completed",
          result_path: args.at(-1),
          total_runs: 1,
          total_result: 1,
        })}\n`,
      );
    else if (scenario.line) child.stdout.write(`${scenario.line}\n`);
    child.close(scenario.code);
    assert.equal(events.at(-1)?.status, scenario.status);
  }
});

test("uses only trusted native paths and removes temporary IR on close", () => {
  const { args, child, command } = create_task(async () => {});
  assert.equal(command, resolve("build/native/bin/gachasimulate-core"));
  assert.deepEqual(args.slice(2, -2), [
    "--total-runs",
    "1",
    "--seed",
    "0",
    "--threads",
    "1",
  ]);
  const ir = args[1];
  assert.equal(existsSync(ir), true);
  assert.match(
    args.at(-1) ?? "",
    /results\/test-termination-totalRuns-1-seed0-threads1-.*\.gsr$/,
  );
  child.close(1);
  assert.equal(existsSync(ir), false);
});

test("keeps only a successfully completed GSR", async () => {
  const success = create_task(async () => {});
  const success_output = success.args.at(-1)!;
  writeFileSync(success_output, "complete");
  success.child.stdout.write(
    `${JSON.stringify({
      type: "completed",
      result_path: success_output,
      total_runs: 1,
      total_result: 1,
    })}\n`,
  );
  success.child.close(0);
  assert.equal(existsSync(success_output), true);
  unlinkSync(success_output);

  const failed = create_task(async () => {});
  const failed_output = failed.args.at(-1)!;
  writeFileSync(failed_output, "partial");
  failed.child.close(1);
  assert.equal(existsSync(failed_output), false);

  const cancelled = create_task(async () => {});
  const cancelled_output = cancelled.args.at(-1)!;
  writeFileSync(cancelled_output, "partial");
  const stopping = cancelled.task.cancel();
  cancelled.child.close(null, "SIGTERM");
  await stopping;
  assert.equal(existsSync(cancelled_output), false);
});

test("spawn failure removes the temporary IR", () => {
  let ir = "";
  const task = new SimulationTask(
    resolve("test-fixtures/configs"),
    resolve("results"),
    () => {},
    {
      local_dir: () => resolve("test-fixtures/configs"),
      spawn: (_command, args) => {
        ir = args[1];
        throw new Error("spawn failed");
      },
    },
  );
  assert.throws(() => task.start(request), /spawn failed/);
  assert.equal(existsSync(ir), false);
});

test("shutdown stops active simulation and analyzer tasks together", async () => {
  const calls: string[] = [];
  await shutdown_native_processes(
    { active: true, cancel: async () => void calls.push("simulation") },
    { active: true, cancel: async () => void calls.push("analyzer") },
    { active: false, cancel: async () => void calls.push("inactive") },
  );
  assert.deepEqual(calls.sort(), ["analyzer", "simulation"]);
});
