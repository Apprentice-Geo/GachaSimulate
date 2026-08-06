import assert from "node:assert/strict";
import test from "node:test";
import {
  parse_simulation_line,
  resolve_process_outcome,
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

test("validates exclusive positive targets and worker limit", () => {
  validate_simulation_request(request, 2);
  assert.throws(() => validate_simulation_request({ ...request, workers: 3 }, 2));
  assert.throws(() => validate_simulation_request({ ...request, target: { kind: "totalRuns", value: 0 } }, 2));
});

test("parses JSONL and ignores unknown events", () => {
  const diagnostics: string[] = [];
  assert.equal(parse_simulation_line("", diagnostics), null);
  assert.deepEqual(parse_simulation_line('{"type":"progress","completed":1,"total":2,"unit":"runs"}'), {
    type: "progress", completed: 1, total: 2, unit: "runs",
  });
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
