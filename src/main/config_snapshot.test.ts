import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConfigSnapshotEngine,
  validate_package_snapshot,
} from "./config_snapshot";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gachasimulate-snapshot-"));
  const installed = join(directory, "installed");
  const local = join(directory, "local");
  mkdirSync(installed);
  mkdirSync(local);
  const path = join(local, "test");
  cpSync("test-fixtures/configs/test", path, { recursive: true });
  let validations = 0;
  const engine = new ConfigSnapshotEngine((snapshot) => {
    validations += 1;
    return validate_package_snapshot(snapshot);
  });
  return {
    directory,
    installed,
    local,
    path,
    engine,
    validations: () => validations,
  };
}

test("each query reads content and reuses only unchanged full-package validation", () => {
  const w = fixture();
  try {
    const first = w.engine.scan(w.installed, w.local);
    assert.equal(first.local.length, 1);
    assert.equal(w.engine.scan(w.installed, w.local).local.length, 1);
    assert.equal(w.validations(), 1);
    const path = join(w.path, "manifest.yaml");
    const stat = statSync(path);
    const contents = readFileSync(path, "utf8");
    writeFileSync(path, contents.replace("name: test", "name: edit"));
    utimesSync(path, stat.atime, stat.mtime);
    assert.equal(
      w.engine.scan(w.installed, w.local).local[0]?.config.name,
      "edit",
    );
    assert.equal(w.validations(), 2);
    writeFileSync(join(w.path, "extra.yaml"), "invalid: true");
    assert.equal(w.engine.scan(w.installed, w.local).local.length, 0);
    rmSync(join(w.path, "extra.yaml"));
    writeFileSync(join(w.path, "termination.yaml"), "termination_rule: {}\n");
    assert.equal(w.engine.scan(w.installed, w.local).local.length, 0);
    cpSync(
      "test-fixtures/configs/test/termination.yaml",
      join(w.path, "termination.yaml"),
    );
    assert.equal(w.engine.scan(w.installed, w.local).local.length, 1);
    rmSync(w.path, { recursive: true });
    assert.equal(w.engine.scan(w.installed, w.local).local.length, 0);
    rmSync(w.local, { recursive: true });
    assert.match(w.engine.scan(w.installed, w.local).local_error!, /不存在/);
  } finally {
    rmSync(w.directory, { recursive: true, force: true });
  }
});

test("installation metadata and first installed query reuse the validated YAML receipt", () => {
  const w = fixture();
  try {
    const receipt = w.engine.validate_directory(w.path, "test", "local");
    const digest = "a".repeat(64);
    writeFileSync(
      join(w.path, ".gachasimulate.json"),
      JSON.stringify({ sha256: digest }),
    );
    w.engine.verify_install(w.path, "test", receipt, digest);
    renameSync(w.path, join(w.installed, "test"));
    const snapshot = w.engine.scan(w.installed, w.local);
    assert.equal(snapshot.installed[0]?.sha256, digest);
    assert.equal(snapshot.installed[0]?.config.source, "installed");
    assert.equal(w.validations(), 1);
    writeFileSync(join(w.installed, "test", ".gachasimulate.json"), "{}");
    assert.equal(w.engine.scan(w.installed, w.local).installed.length, 0);
  } finally {
    rmSync(w.directory, { recursive: true, force: true });
  }
});

test("run compilation rereads and validates actual inputs instead of trusting list cache", () => {
  const w = fixture();
  try {
    assert.equal(w.engine.scan(w.installed, w.local).local.length, 1);
    writeFileSync(join(w.path, "termination.yaml"), "termination_rule: {}\n");
    assert.throws(
      () =>
        w.engine.compile(
          w.path,
          "test",
          "local",
          "termination.yaml",
          "draw_count",
        ),
      /validation failed/,
    );
  } finally {
    rmSync(w.directory, { recursive: true, force: true });
  }
});
