import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import type { ChildProcess } from "node:child_process";
import { shutdown_native_processes, SimulationTask } from "./simulation";
import { resolve_native_executable } from "./native_process";
import { ConfigSnapshotEngine } from "./config_snapshot";
import type { CompiledProgram } from "@gachasimulate/config-compiler";
import type { ConfigWork } from "./config_worker_protocol";
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

const simulation_results = mkdtempSync(
  join(tmpdir(), "gachasimulate-simulation-results-"),
);
let result_directory_id = 0;
after(() => rmSync(simulation_results, { recursive: true, force: true }));

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

async function create_task(
  terminate: (child: ChildProcess) => Promise<void>,
  close_timeout_ms = 100,
  simulation_request = request,
  results_dir = join(simulation_results, String(result_directory_id++)),
) {
  const child = new FakeChild();
  const events: DesktopSimulationEvent[] = [];
  let command = "";
  let args: string[] = [];
  const task = new SimulationTask(
    resolve("test-fixtures/configs"),
    results_dir,
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
      prepare_program: async (value) =>
        new ConfigSnapshotEngine().compile(
          resolve("test-fixtures/configs", value.configId),
          value.configId,
          value.configSource,
          value.termination,
          value.resultItem,
        ),
    },
  );
  await task.start(simulation_request);
  child.stdout.write('{"type":"started"}\n');
  return { args, child, command, events, task };
}

function complete(value: Awaited<ReturnType<typeof create_task>>): string {
  const temporary = value.args.at(-1)!;
  writeFileSync(temporary, "complete");
  value.child.stdout.write(
    `${JSON.stringify({
      type: "completed",
      result_path: temporary,
      total_runs: 1,
      total_result: 1,
    })}\n`,
  );
  value.child.close(0);
  const event = value.events.at(-1)?.event;
  assert.equal(event?.type, "completed");
  return event.result_path;
}

test("validates strict requests, positive targets, and thread limit", () => {
  validate_simulation_request(request, 2);
  validate_simulation_request(
    { ...request, target: { kind: "totalRuns", value: 1_000_000_007 } },
    2,
  );
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
      { ...request, target: { kind: "totalRuns", value: 1_000_000_008 } },
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

test("starts local and installed configs with the same id by source", async () => {
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
    const paths: string[] = [];
    for (const configSource of ["local", "installed"] as const) {
      const child = new FakeChild();
      const events: DesktopSimulationEvent[] = [];
      let output = "";
      const task = new SimulationTask(
        join(root, "installed"),
        join(root, "results"),
        (event) => events.push(event),
        {
          local_dir: () => resolve("test-fixtures/configs"),
          spawn: (_command, args) => {
            output = args.at(-1)!;
            return child as unknown as ChildProcess;
          },
        },
      );
      await task.start({ ...request, configSource });
      assert.equal(task.active, true);
      writeFileSync(output, "complete");
      child.stdout.write(
        `${JSON.stringify({
          type: "completed",
          result_path: output,
          total_runs: 1,
          total_result: 1,
        })}\n`,
      );
      child.close(0);
      const event = events.at(-1)?.event;
      assert.equal(event?.type, "completed");
      paths.push(event.result_path);
      assert.equal(task.active, false);
    }
    assert.notEqual(paths[0], paths[1]);
    assert.match(basename(paths[0]), /^local-/);
    assert.match(basename(paths[1]), /^installed-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaves room for the visualize sidecar with long valid names", async () => {
  const root = mkdtempSync(join(tmpdir(), "gachasimulate-long-result-"));
  try {
    const config_dir = join(root, "configs", "test");
    cpSync(resolve("test-fixtures/configs/test"), config_dir, {
      recursive: true,
    });
    const termination = `${"t".repeat(240)}.yaml`;
    renameSync(
      join(config_dir, "termination.yaml"),
      join(config_dir, termination),
    );
    const manifest_path = join(config_dir, "manifest.yaml");
    writeFileSync(
      manifest_path,
      readFileSync(manifest_path, "utf8").replace(
        "termination.yaml",
        termination,
      ),
    );
    const child = new FakeChild();
    const events: DesktopSimulationEvent[] = [];
    let output = "";
    const task = new SimulationTask(
      join(root, "installed"),
      join(root, "results"),
      (event) => events.push(event),
      {
        local_dir: () => join(root, "configs"),
        spawn: (_command, args) => {
          output = args.at(-1)!;
          return child as unknown as ChildProcess;
        },
      },
    );
    await task.start({ ...request, termination });
    writeFileSync(output, "complete");
    child.stdout.write(
      `${JSON.stringify({
        type: "completed",
        result_path: output,
        total_runs: 1,
        total_result: 1,
      })}\n`,
    );
    child.close(0);
    const event = events.at(-1)?.event;
    assert.equal(event?.type, "completed");
    assert.ok(
      Buffer.byteLength(
        basename(event.result_path).replace(/\.gsr$/, ".visualize.json"),
      ) <= 255,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancels only after the child closes", async () => {
  const { child, events, task } = await create_task(async () => {});

  const cancelling = task.cancel();
  assert.equal(events.at(-1)?.status, "cancelling");
  assert.equal(task.active, true);

  child.close(null, "SIGTERM");
  await cancelling;
  assert.equal(events.at(-1)?.status, "cancelled");
  assert.equal(task.active, false);
});

test("failed termination keeps cancellation latched and allows retry", async () => {
  let attempts = 0;
  const { child, events, task } = await create_task(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("access denied");
  });

  await assert.rejects(task.cancel(), /access denied/);
  assert.equal(events.at(-1)?.status, "cancelling");
  assert.equal(task.active, true);

  const retry = task.cancel();
  child.close(null, "SIGTERM");
  await retry;
  assert.equal(events.at(-1)?.status, "cancelled");
});

test("child close wins when termination reports an error", async () => {
  const { events, task } = await create_task(async (child) => {
    (child as unknown as FakeChild).close(null, "SIGTERM");
    throw new Error("already gone");
  });

  await task.cancel();
  assert.equal(events.at(-1)?.status, "cancelled");
  assert.equal(task.active, false);
});

test("close timeout keeps cancellation latched until the child exits", async () => {
  const { args, child, events, task } = await create_task(async () => {}, 5);

  await assert.rejects(task.cancel(), /timed out/);
  assert.equal(events.at(-1)?.status, "cancelling");
  assert.equal(task.active, true);
  writeFileSync(args.at(-1)!, "complete");
  child.stdout.write(
    `${JSON.stringify({
      type: "completed",
      result_path: args.at(-1),
      total_runs: 1,
      total_result: 1,
    })}\n`,
  );
  child.close(0);
  assert.equal(events.at(-1)?.status, "cancelled");
  assert.equal(existsSync(args.at(-1)!), false);
});

test("cancellation discards even a completed output and suppresses late events", async () => {
  for (const completed_before_cancel of [false, true]) {
    for (const termination_fails of [false, true]) {
      const results_dir = join(
        simulation_results,
        String(result_directory_id++),
      );
      const { args, child, events, task } = await create_task(
        async () => {
          if (termination_fails) throw new Error("access denied");
        },
        100,
        request,
        results_dir,
      );
      const output = args.at(-1)!;
      writeFileSync(output, "complete");
      const completion = `${JSON.stringify({
        type: "completed",
        result_path: output,
        total_runs: 1,
        total_result: 1,
      })}\n`;
      child.stdout.write(
        '{"type":"progress","completed":42,"total":100,"unit":"runs"}\n',
      );
      if (completed_before_cancel) child.stdout.write(completion);
      const stopping = task.cancel();
      if (termination_fails) await assert.rejects(stopping, /access denied/);
      const count_after_cancel = events.length;
      child.stdout.write(
        '{"type":"started"}\n' +
          '{"type":"stage","stage":"saving"}\n' +
          '{"type":"progress","completed":100,"total":100,"unit":"runs"}\n' +
          completion,
      );
      assert.equal(events.length, count_after_cancel);
      child.close(0);
      if (!termination_fails) await stopping;
      assert.equal(events.at(-1)?.status, "cancelled");
      assert.equal(
        events.some(({ status }) => status === "completed"),
        false,
      );
      assert.deepEqual(readdirSync(results_dir), []);
    }
  }
});

test("cancel waits for stdout close when the native process has already exited", async () => {
  let termination_attempts = 0;
  const { child, events, task } = await create_task(async () => {
    termination_attempts++;
    throw new Error("already exited");
  });
  child.exitCode = 0;
  const stopping = task.cancel();
  assert.equal(termination_attempts, 0);
  assert.equal(task.active, true);
  child.close(0);
  await stopping;
  assert.equal(events.at(-1)?.status, "cancelled");
});

test("invalid JSONL keeps the task active until close then fails", async () => {
  let terminate_calls = 0;
  const { child, events, task } = await create_task(async () => {
    terminate_calls += 1;
  });

  child.stdout.write("not json\n");
  await Promise.resolve();
  assert.equal(terminate_calls, 1);
  assert.equal(events.at(-1)?.status, "cancelling");
  assert.equal(task.active, true);
  await assert.rejects(() => task.start(request), /already running/);

  child.close(1);
  assert.equal(events.at(-1)?.status, "failed");
  assert.equal(events.at(-1)?.message, "invalid JSONL event");
  assert.equal(task.active, false);
});

test("assembles chunked JSONL and rejects oversized complete or partial lines once", async () => {
  const normal = await create_task(async () => {});
  normal.child.stdout.write('{"type":"pro');
  normal.child.stdout.write('gress","completed":1,"total":1,"unit":"runs"}\n');
  assert.equal(normal.events.at(-1)?.event?.type, "progress");
  normal.child.close(1);

  for (const chunks of [
    ["x".repeat(64 * 1024 + 1), "\n"],
    ["x".repeat(32 * 1024), "x".repeat(32 * 1024 + 1)],
  ]) {
    let terminate_calls = 0;
    const value = await create_task(async () => {
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
  const { child, events, task } = await create_task(async () => {
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

test("core error event becomes terminal only after close", async () => {
  const { child, events, task } = await create_task(async () => {});

  child.stdout.write('{"type":"error","message":"bad config"}\n');
  assert.equal(events.at(-1)?.status, "running");
  assert.equal(events.at(-1)?.message, "bad config");
  assert.equal(task.active, true);

  child.close(1);
  assert.equal(events.at(-1)?.status, "failed");
  assert.equal(events.at(-1)?.message, "bad config");
});

test("requires a matching terminal event and exit code", async () => {
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
    const { args, child, events } = await create_task(async () => {});
    if (scenario.line === "completed") {
      writeFileSync(args.at(-1)!, "complete");
      child.stdout.write(
        `${JSON.stringify({
          type: "completed",
          result_path: args.at(-1),
          total_runs: 1,
          total_result: 1,
        })}\n`,
      );
    } else if (scenario.line) child.stdout.write(`${scenario.line}\n`);
    child.close(scenario.code);
    assert.equal(events.at(-1)?.status, scenario.status);
  }
});

test("uses only trusted native paths and removes temporary IR on close", async () => {
  const { args, child, command } = await create_task(async () => {});
  assert.equal(
    command,
    resolve(
      `build/native/bin/gachasimulate-core${process.platform === "win32" ? ".exe" : ""}`,
    ),
  );
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
  assert.match(basename(args.at(-1) ?? ""), /^\.[0-9a-f-]+\.tmp\.gsr$/);
  child.close(1);
  assert.equal(existsSync(ir), false);
  assert.equal(
    resolve_native_executable("tool", "/tmp/native"),
    resolve(`/tmp/native/tool${process.platform === "win32" ? ".exe" : ""}`),
  );
});

test("keeps only a successfully completed GSR", async () => {
  const success = await create_task(async () => {});
  const success_output = complete(success);
  assert.equal(existsSync(success_output), true);

  const failed = await create_task(async () => {});
  const failed_output = failed.args.at(-1)!;
  writeFileSync(failed_output, "partial");
  failed.child.close(1);
  assert.equal(existsSync(failed_output), false);

  const cancelled = await create_task(async () => {});
  const cancelled_output = cancelled.args.at(-1)!;
  writeFileSync(cancelled_output, "partial");
  const stopping = cancelled.task.cancel();
  cancelled.child.close(null, "SIGTERM");
  await stopping;
  assert.equal(existsSync(cancelled_output), false);
});

test("uses deterministic result identities and replaces stale results", async () => {
  const results = join(simulation_results, "replacement");
  const first = await create_task(async () => {}, 100, request, results);
  const final = complete(first);
  const sidecar = final.replace(/\.gsr$/, ".visualize.json");
  writeFileSync(final, "old result");
  writeFileSync(sidecar, "old sidecar");

  const replacement = await create_task(async () => {}, 100, request, results);
  const replaced = complete(replacement);

  assert.equal(replaced, final);
  assert.equal(readFileSync(final, "utf8"), "complete");
  assert.equal(existsSync(sidecar), false);
  assert.match(
    basename(final),
    /^local-test-termination-draw_count-[0-9a-f]{12}-runs1-seed0-threads1\.gsr$/,
  );
});

test("failed replacement preserves the previous result and sidecar", async () => {
  const results = join(simulation_results, "failed-replacement");
  const initial = await create_task(async () => {}, 100, request, results);
  const final = complete(initial);
  const sidecar = final.replace(/\.gsr$/, ".visualize.json");
  writeFileSync(final, "old result");
  writeFileSync(sidecar, "old sidecar");

  const failed = await create_task(async () => {}, 100, request, results);
  writeFileSync(failed.args.at(-1)!, "partial");
  failed.child.close(1);
  assert.equal(readFileSync(final, "utf8"), "old result");
  assert.equal(readFileSync(sidecar, "utf8"), "old sidecar");

  const cancelled = await create_task(async () => {}, 100, request, results);
  writeFileSync(cancelled.args.at(-1)!, "partial");
  const stopping = cancelled.task.cancel();
  cancelled.child.close(null, "SIGTERM");
  await stopping;
  assert.equal(readFileSync(final, "utf8"), "old result");
  assert.equal(readFileSync(sidecar, "utf8"), "old sidecar");
});

test("includes result item in the deterministic identity", async () => {
  const results = join(simulation_results, "result-items");
  const draw = await create_task(async () => {}, 100, request, results);
  const target = await create_task(
    async () => {},
    100,
    { ...request, resultItem: "target_item_1" },
    results,
  );
  const draw_path = complete(draw);
  const target_path = complete(target);

  assert.notEqual(draw_path, target_path);
  assert.match(basename(target_path), /^local-test-termination-target_item_1-/);
});

test("spawn failure removes the temporary IR", async () => {
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
  await assert.rejects(() => task.start(request), /spawn failed/);
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

test("preparation holds the task identity and cancellation prevents a delayed native spawn", async () => {
  let finish!: (program: CompiledProgram) => void;
  const preparing = new Promise<CompiledProgram>((resolve) => {
    finish = resolve;
  });
  let spawned = 0;
  let preparation_started = false;
  const events: DesktopSimulationEvent[] = [];
  const task = new SimulationTask(
    resolve("test-fixtures/configs"),
    simulation_results,
    (event) => events.push(event),
    {
      local_dir: () => resolve("test-fixtures/configs"),
      prepare_program: () => {
        preparation_started = true;
        return preparing;
      },
      spawn: () => {
        spawned += 1;
        return new FakeChild() as unknown as ChildProcess;
      },
    },
  );
  const starting = task.start(request);
  assert.equal(task.active, true);
  await assert.rejects(task.start(request), /already running/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(preparation_started, true);
  let cancellation_finished = false;
  const cancelling = task.cancel().then(() => {
    cancellation_finished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancellation_finished, false);
  finish({ ir: {} } as CompiledProgram);
  await Promise.all([starting, cancelling]);
  assert.equal(spawned, 0);
  assert.equal(task.active, false);
  assert.equal(events.at(-1)?.status, "cancelled");
});

test("preparation rechecks admission before starting native code", async () => {
  let finish!: (program: CompiledProgram) => void;
  const preparing = new Promise<CompiledProgram>((resolve) => {
    finish = resolve;
  });
  let spawned = 0;
  const task = new SimulationTask(
    resolve("test-fixtures/configs"),
    simulation_results,
    () => undefined,
    {
      local_dir: () => resolve("test-fixtures/configs"),
      prepare_program: () => preparing,
      assert_start_allowed: () => {
        throw new Error("application is shutting down");
      },
      spawn: () => {
        spawned += 1;
        return new FakeChild() as unknown as ChildProcess;
      },
    },
  );
  const starting = task.start(request);
  const rejected = assert.rejects(starting, /shutting down/);
  finish({ ir: {} } as CompiledProgram);
  await rejected;
  assert.equal(spawned, 0);
  assert.equal(task.active, false);
});

test("a failed owned-worker stop preserves preparation cleanup and retries cancellation", async () => {
  let reject_compile!: (reason: Error) => void;
  const compile = new Promise<CompiledProgram>((_resolve, reject) => {
    reject_compile = reject;
  });
  let stops = 0;
  let resumed = 0;
  let spawned = 0;
  const work: ConfigWork = {
    request: () => compile as never,
    stop: async () => {
      stops += 1;
      reject_compile(new Error("compile stopped"));
      if (stops === 1) throw new Error("worker termination blocked");
    },
    resume: () => {
      resumed += 1;
    },
  };
  const events: DesktopSimulationEvent[] = [];
  const task = new SimulationTask(
    resolve("test-fixtures/configs"),
    simulation_results,
    (event) => events.push(event),
    {
      local_dir: () => resolve("test-fixtures/configs"),
      config_work: work,
      spawn: () => {
        spawned += 1;
        return new FakeChild() as unknown as ChildProcess;
      },
    },
  );
  const starting = task.start(request);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(task.cancel(), /termination blocked/);
  await starting;
  assert.equal(task.active, true);
  assert.equal(events.at(-1)?.status, "cancelling");
  await assert.rejects(task.start(request), /already running/);
  await task.cancel();
  assert.equal(task.active, false);
  assert.equal(stops, 2);
  assert.equal(resumed, 1);
  assert.equal(spawned, 0);
});
