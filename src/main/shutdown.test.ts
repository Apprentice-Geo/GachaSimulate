import assert from "node:assert/strict";
import test from "node:test";
import { UserRequestAdmission } from "./request_admission";
import { ShutdownCoordinator } from "./shutdown";

test("failed shutdown waits for every owner, deduplicates, and recovers only global admission", async () => {
  const admission = new UserRequestAdmission();
  admission.reserve_export("retained-export");
  let finish!: () => void;
  let calls = 0;
  let fail = true;
  const coordinator = new ShutdownCoordinator(admission, [
    async () => {
      calls += 1;
      if (fail) throw new Error("cannot terminate");
    },
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  ]);
  const pending = coordinator.stop();
  assert.equal(coordinator.stop(), pending);
  const rejected = assert.rejects(pending, /cannot terminate/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.throws(() => admission.admit("analysis"), /shutting down/);
  finish();
  await rejected;
  assert.throws(() => admission.admit("analysis"), /during export/);
  admission.release_export("retained-export");
  admission.admit("analysis");
  fail = false;
  const retry = coordinator.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  finish();
  await retry;
  assert.equal(calls, 2);
  assert.throws(() => admission.admit("analysis"), /shutting down/);
});
