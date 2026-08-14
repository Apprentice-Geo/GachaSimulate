import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  scan_installed_configs,
  validate_installed_config_selection,
} from "./config_manager";

function temporary_directory(): string {
  return mkdtempSync(join(tmpdir(), "gachasimulate-config-manager-"));
}

function write_config(
  root: string,
  directory_name: string,
  manifest = `id: ${directory_name}\nname: Test\ndescription: Test config\nterminations:\n  - file: termination.yaml\n    name: Done\n`,
): string {
  const directory = join(root, directory_name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "manifest.yaml"), manifest);
  writeFileSync(
    join(directory, "config.yaml"),
    "items: [{draw_count: 抽数}, target]\n",
  );
  writeFileSync(join(directory, "termination.yaml"), "termination_rule: {}\n");
  return directory;
}

test("scans valid manifests and skips invalid installed configs", () => {
  const installed = temporary_directory();
  try {
    write_config(installed, "valid");
    write_config(installed, "broken", "{invalid");
    write_config(
      installed,
      "mismatch",
      "id: other\nname: Test\ndescription: Test\nterminations:\n  - file: termination.yaml\n    name: Done\n",
    );
    write_config(
      installed,
      "traversal",
      "id: traversal\nname: Test\ndescription: Test\nterminations:\n  - file: ..\n    name: Done\n",
    );
    write_config(
      installed,
      "separator",
      "id: separator\nname: Test\ndescription: Test\nterminations:\n  - file: nested/termination.yaml\n    name: Done\n",
    );
    const missingTermination = write_config(installed, "missing-termination");
    rmSync(join(missingTermination, "termination.yaml"));
    const missingConfig = write_config(installed, "missing-config");
    rmSync(join(missingConfig, "config.yaml"));

    assert.deepEqual(scan_installed_configs(installed), [
      {
        id: "valid",
        name: "Test",
        description: "Test config",
        terminations: [{ file: "termination.yaml", name: "Done" }],
        items: [
          { id: "draw_count", name: "抽数" },
          { id: "target", name: "target" },
        ],
      },
    ]);
  } finally {
    rmSync(installed, { recursive: true, force: true });
  }
});

test("skips configs with invalid items", () => {
  const installed = temporary_directory();
  try {
    const invalid = write_config(installed, "invalid");
    writeFileSync(join(invalid, "config.yaml"), "items: [same, same]\n");
    assert.deepEqual(scan_installed_configs(installed), []);
  } finally {
    rmSync(installed, { recursive: true, force: true });
  }
});

test("only manifest-declared configuration selections can start", () => {
  const installed = temporary_directory();
  try {
    const directory = write_config(installed, "valid");
    writeFileSync(join(directory, "undeclared.yaml"), "termination_rule: {}\n");

    assert.doesNotThrow(() =>
      validate_installed_config_selection(
        installed,
        "valid",
        "termination.yaml",
      ),
    );
    assert.throws(
      () =>
        validate_installed_config_selection(
          installed,
          "valid",
          "undeclared.yaml",
        ),
      /not declared/,
    );
    assert.throws(
      () =>
        validate_installed_config_selection(
          installed,
          "missing",
          "termination.yaml",
        ),
      /not found/,
    );
  } finally {
    rmSync(installed, { recursive: true, force: true });
  }
});
