import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CDFViewModel } from "../visualize/types/cdf";
import type { DesktopExportEvent } from "../shared/export_task";
import type { ResultSnapshot } from "./result_editor";
import { UserRequestAdmission } from "./request_admission";
import { ExportTaskCoordinator } from "./export_task";
import { ExportCancelledError } from "./export_host";
import {
  validate_export_cancel_request,
  validate_export_destination_request,
  validate_export_preparation_request,
} from "../shared/export_task";

const snapshot = {
  session_id: "session",
  path: "C:\\results\\result.gsr",
  stem: "result",
  analysis: {},
  display: {},
  view_model: {} as CDFViewModel,
} as ResultSnapshot;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve_value, reject_value) => {
    resolve = resolve_value;
    reject = reject_value;
  });
  return { promise, resolve, reject };
}

class FakeHost {
  readonly completion = deferred<void>();
  readonly saved_artifacts: Array<{ format: "mp4" | "png"; path: string }> = [];
  readonly residual_paths: string[] = [];
  readonly cleanup_failed = false;
  cancelled = false;

  start(): Promise<void> {
    return this.completion.promise;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.completion.reject(new ExportCancelledError());
  }

  async inspect_residual_paths(): Promise<string[]> {
    return this.residual_paths;
  }
}

test("reservation synchronously blocks new requests and hands off without a gap", async () => {
  const admission = new UserRequestAdmission();
  const events: DesktopExportEvent[] = [];
  const ids = ["reservation", "rejected-reservation", "task"];
  const host = new FakeHost();
  const editor = {
    wait_for_pending_saves: async () => undefined,
    snapshot_now: () => snapshot,
  };
  const coordinator = new ExportTaskCoordinator(
    editor as never,
    admission,
    (event) => events.push(event),
    {
      random_uuid: () => ids.shift()!,
      host_factory: () => host as never,
    },
  );

  const accepted = coordinator.prepare({
    session_id: "session",
    formats: ["png"],
    base_name: "result",
  });
  assert.equal(accepted.reservation_id, "reservation");
  assert.throws(() => admission.admit("simulation"), /during export/);
  assert.throws(
    () =>
      coordinator.prepare({
        session_id: "session",
        formats: ["png"],
        base_name: "result",
      }),
    /already active/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    events.some(({ type }) => type === "preparation-ready"),
    true,
  );

  const task_id = coordinator.commit_reservation(
    "reservation",
    { png: "C:\\exports\\result.png" },
    { png: { exists: false } },
  );
  assert.equal(task_id, "task");
  assert.throws(() => admission.admit("analysis"), /during export/);
  host.saved_artifacts.push({ format: "png", path: "C:\\exports\\result.png" });
  host.completion.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  admission.admit("analysis");
  assert.equal(events.at(-1)?.type, "completed");
});

test("preparation cancellation is acknowledged before snapshot work finishes", async () => {
  const admission = new UserRequestAdmission();
  const events: DesktopExportEvent[] = [];
  const pending = deferred<ResultSnapshot>();
  const coordinator = new ExportTaskCoordinator(
    {
      wait_for_pending_saves: () => pending.promise.then(() => undefined),
      snapshot_now: () => snapshot,
    } as never,
    admission,
    (event) => events.push(event),
    { random_uuid: () => "reservation" },
  );
  coordinator.prepare({
    session_id: "session",
    formats: ["mp4", "png"],
    base_name: "result",
  });
  const cancelling = coordinator.cancel({
    reservation_id: "reservation",
    reason: "cancelled",
  });
  assert.deepEqual(events.at(-1), {
    type: "preparation-status",
    reservation_id: "reservation",
    stage: "cancelling",
  });
  pending.resolve(snapshot);
  await cancelling;
  assert.equal(events.at(-1)?.type, "preparation-cancelled");
  admission.admit("simulation");
});

test("formal cancellation emits one cancelled terminal and releases admission", async () => {
  const admission = new UserRequestAdmission();
  const events: DesktopExportEvent[] = [];
  const ids = ["reservation", "task"];
  const host = new FakeHost();
  const coordinator = new ExportTaskCoordinator(
    {
      wait_for_pending_saves: async () => undefined,
      snapshot_now: () => snapshot,
    } as never,
    admission,
    (event) => events.push(event),
    {
      random_uuid: () => ids.shift()!,
      host_factory: () => host as never,
    },
  );
  coordinator.prepare({
    session_id: "session",
    formats: ["mp4"],
    base_name: "result",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  coordinator.commit_reservation(
    "reservation",
    { mp4: "C:\\exports\\result.mp4" },
    { mp4: { exists: false } },
  );
  await coordinator.cancel({ task_id: "task" });
  assert.equal(host.cancelled, true);
  assert.equal(events.filter(({ type }) => type === "cancelled").length, 1);
  admission.admit("config-change");
});

test("shared export validation rejects unsafe Windows base names and unsupported fields", () => {
  for (const base_name of [
    "",
    ".",
    "..",
    "CON",
    "com1.log",
    "tail. ",
    "a/b",
    "a:b",
    "line\nfeed",
    "x".repeat(252),
  ])
    assert.throws(
      () =>
        validate_export_preparation_request({
          session_id: "session",
          formats: ["png"],
          base_name,
        }),
      /base name/,
    );
  assert.throws(
    () =>
      validate_export_preparation_request({
        session_id: "session",
        formats: ["png"],
        base_name: "result",
        path: "C:\\secret",
      }),
    /unsupported fields/,
  );
  assert.throws(
    () =>
      validate_export_destination_request({
        reservation_id: "reservation",
        path: "C:\\secret",
      }),
    /invalid export destination request/,
  );
  assert.throws(
    () => validate_export_cancel_request({ reservation_id: "reservation" }),
    /invalid export cancel request/,
  );
});

test("destination cancellation releases the reservation with a returned reason", async () => {
  const admission = new UserRequestAdmission();
  const events: DesktopExportEvent[] = [];
  const coordinator = new ExportTaskCoordinator(
    {
      wait_for_pending_saves: async () => undefined,
      snapshot_now: () => snapshot,
    } as never,
    admission,
    (event) => events.push(event),
    { random_uuid: () => "reservation" },
  );
  coordinator.prepare({
    session_id: "session",
    formats: ["png"],
    base_name: "result",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    await coordinator.select_destination(
      { reservation_id: "reservation" },
      async () => null,
    ),
    { status: "returned" },
  );
  assert.deepEqual(events.at(-1), {
    type: "preparation-cancelled",
    reservation_id: "reservation",
    reason: "destination-returned",
  });
  admission.admit("simulation");
});

test("destination selection starts a task without an admission gap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gachasimulate-target-"));
  const admission = new UserRequestAdmission();
  const events: DesktopExportEvent[] = [];
  const ids = ["reservation", "task"];
  const host = new FakeHost();
  let host_request: { target_identities?: unknown } | undefined;
  const coordinator = new ExportTaskCoordinator(
    {
      wait_for_pending_saves: async () => undefined,
      snapshot_now: () => snapshot,
    } as never,
    admission,
    (event) => events.push(event),
    {
      random_uuid: () => ids.shift()!,
      host_factory: (request) => {
        host_request = request;
        return host as never;
      },
    },
  );
  coordinator.prepare({
    session_id: "session",
    formats: ["png"],
    base_name: "result",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const result = await coordinator.select_destination(
    { reservation_id: "reservation" },
    async () => directory,
  );
  assert.deepEqual(result, { status: "started", task_id: "task" });
  assert.deepEqual(host_request?.target_identities, {
    png: { exists: false },
  });
  assert.throws(() => admission.admit("analysis"), /during export/);
  host.completion.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("overwrite confirmation rejects a target changed after selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gachasimulate-overwrite-"));
  const target = join(directory, "result.png");
  await writeFile(target, "old");
  const admission = new UserRequestAdmission();
  const events: DesktopExportEvent[] = [];
  const coordinator = new ExportTaskCoordinator(
    {
      wait_for_pending_saves: async () => undefined,
      snapshot_now: () => snapshot,
    } as never,
    admission,
    (event) => events.push(event),
    { random_uuid: () => "reservation" },
  );
  coordinator.prepare({
    session_id: "session",
    formats: ["png"],
    base_name: "result",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    await coordinator.select_destination(
      { reservation_id: "reservation" },
      async () => directory,
    ),
    { status: "overwrite-required", files: ["result.png"] },
  );
  await writeFile(target, "changed-and-larger");
  await assert.rejects(
    coordinator.confirm_overwrite({ reservation_id: "reservation" }),
    /target changed/,
  );
  assert.equal(events.at(-1)?.type, "preparation-failed");
  admission.admit("analysis");
});

test("destination validation rejects non-file targets", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "gachasimulate-invalid-target-"),
  );
  await mkdir(join(directory, "result.png"));
  const coordinator = new ExportTaskCoordinator(
    {
      wait_for_pending_saves: async () => undefined,
      snapshot_now: () => snapshot,
    } as never,
    new UserRequestAdmission(),
    () => undefined,
    { random_uuid: () => "reservation" },
  );
  const reservation_id = coordinator.prepare({
    session_id: "session",
    formats: ["png"],
    base_name: "result",
  }).reservation_id;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    coordinator.select_destination({ reservation_id }, async () => directory),
    /regular file/,
  );
  assert.equal(
    await readFile(join(directory, "result.png")).catch(() => null),
    null,
  );
});

test("destination validation rejects a canonical Windows path beyond the long-path limit", async () => {
  const coordinator = new ExportTaskCoordinator(
    {
      wait_for_pending_saves: async () => undefined,
      snapshot_now: () => snapshot,
    } as never,
    new UserRequestAdmission(),
    () => undefined,
    {
      random_uuid: () => "reservation",
      files: {
        realpath: async () => `C:\\${"x".repeat(32_760)}`,
        lstat: async () => ({
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
          dev: 0n,
          ino: 0n,
          size: 0n,
          mtimeNs: 0n,
          ctimeNs: 0n,
        }),
      },
    },
  );
  coordinator.prepare({
    session_id: "session",
    formats: ["png"],
    base_name: "result",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    coordinator.select_destination(
      { reservation_id: "reservation" },
      async () => "C:\\chosen",
    ),
    /path is too long/,
  );
});
