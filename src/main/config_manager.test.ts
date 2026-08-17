import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConfigManager,
  resolve_config_selection,
  scan_installed_configs,
  scan_local_configs,
} from "./config_manager";

type ZipEntry = {
  name: string;
  data?: Buffer | string;
  mode?: number;
  platform?: number;
};

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((entry.platform ?? 3) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const manifest = `id: example
name: Example
description: Test configuration
terminations:
  - file: termination.yaml
    name: Done
`;
const config = `schema_version: 2
items: [{draw_count: 抽数}]
pools:
  - main:
      - probability: 1
every_draw: draw_count += 1
`;
const termination = `retained_items: []
termination_rule:
  condition:
    check: draw_count >= 1
    actions: terminate done
`;

function package_entries(): ZipEntry[] {
  return [
    { name: "manifest.yaml", data: manifest },
    { name: "config.yaml", data: config },
    { name: "termination.yaml", data: termination },
  ];
}

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "gachasimulate-config-manager-"));
}

function write_config(
  root: string,
  source: "installed" | "local",
  sha256 = "0".repeat(64),
): string {
  const directory = join(root, "example");
  mkdirSync(directory, { recursive: true });
  for (const entry of package_entries())
    writeFileSync(join(directory, entry.name), entry.data!);
  if (source === "installed")
    writeFileSync(
      join(directory, ".gachasimulate.json"),
      JSON.stringify({ sha256 }),
    );
  return directory;
}

function index_for(archive: Buffer, include = true): Buffer {
  return Buffer.from(
    JSON.stringify({
      format_version: 1,
      configs: include
        ? [
            {
              id: "example",
              name: "Example",
              description: "Test configuration",
              download_url: "packages/example.zip",
              sha256: createHash("sha256").update(archive).digest("hex"),
            },
          ]
        : [],
    }),
  );
}

function manager(
  root: string,
  archive: Buffer,
  options: {
    active?: () => boolean;
    index?: Buffer;
    rename?: typeof renameSync;
  } = {},
): ConfigManager {
  return new ConfigManager(join(root, "configs"), {
    download: async (url) =>
      url.endsWith("index.json")
        ? (options.index ?? index_for(archive))
        : archive,
    simulation_active: options.active ?? (() => false),
    random_uuid: () => "task",
    rename: options.rename,
  });
}

test("strictly scans installed and local configs with the same id", () => {
  const root = temporary();
  try {
    const installed = join(root, "installed");
    const local = join(root, "local");
    write_config(installed, "installed");
    write_config(local, "local");
    assert.equal(scan_installed_configs(installed)[0]?.source, "installed");
    assert.equal(scan_local_configs(local)[0]?.source, "local");
    assert.equal(
      resolve_config_selection(
        installed,
        local,
        "local",
        "example",
        "termination.yaml",
      ),
      join(local, "example"),
    );
    assert.throws(() =>
      resolve_config_selection(
        installed,
        local,
        "installed",
        "example",
        "other.yaml",
      ),
    );

    writeFileSync(join(installed, "example", ".gachasimulate.json"), "{}");
    assert.deepEqual(scan_installed_configs(installed), []);
    writeFileSync(join(local, "example", "extra.txt"), "unexpected");
    assert.deepEqual(scan_local_configs(local), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists one local directory and reports a disappeared directory", async () => {
  const root = temporary();
  try {
    const local_a = join(root, "local-a");
    const local_b = join(root, "local-b");
    mkdirSync(local_a);
    mkdirSync(local_b);
    const archive = zip(package_entries());
    const first = manager(root, archive);
    await first.set_local_directory(local_a);
    await first.set_local_directory(local_b);
    const restarted = manager(root, archive);
    assert.equal(restarted.local_dir, local_b);
    rmSync(local_b, { recursive: true });
    assert.match(restarted.state().localError ?? "", /不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derives available, installed, update, and removed states", async () => {
  const root = temporary();
  try {
    const archive = zip(package_entries());
    const digest = createHash("sha256").update(archive).digest("hex");
    const configs = join(root, "configs");
    const current = manager(root, archive);
    await current.refresh();
    assert.equal(current.state().official[0]?.status, "available");
    write_config(join(configs, "installed"), "installed", digest);
    assert.equal(current.state().official[0]?.status, "installed");
    writeFileSync(
      join(configs, "installed", "example", ".gachasimulate.json"),
      JSON.stringify({ sha256: "f".repeat(64) }),
    );
    assert.equal(current.state().official[0]?.status, "update_available");
    const removed = manager(root, archive, {
      index: index_for(archive, false),
    });
    await removed.refresh();
    assert.equal(removed.state().official[0]?.status, "removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline refresh keeps installed configs available for use and uninstall", async () => {
  const root = temporary();
  try {
    write_config(join(root, "configs", "installed"), "installed");
    const current = new ConfigManager(join(root, "configs"), {
      download: async () => {
        throw new Error("offline");
      },
      simulation_active: () => false,
    });
    const state = await current.refresh();
    assert.match(state.sourceError ?? "", /offline/);
    assert.equal(state.official[0]?.status, "installed");
    assert.equal(current.list_configs()[0]?.source, "installed");
    await current.uninstall("example");
    assert.deepEqual(current.list_configs(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installs a validated archive and startup removes stale staging", async () => {
  const root = temporary();
  try {
    const archive = zip(package_entries());
    const current = manager(root, archive);
    await current.refresh();
    assert.equal(
      (await current.install("example")).official[0]?.status,
      "installed",
    );
    assert.equal(current.list_configs()[0]?.source, "installed");
    mkdirSync(join(root, "configs", ".staging", "stale"), { recursive: true });
    manager(root, archive);
    assert.equal(existsSync(join(root, "configs", ".staging")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed SHA, compiler validation, and commit preserve an old install", async () => {
  const cases: Array<{
    archive: Buffer;
    badIndex?: boolean;
    commit?: boolean;
  }> = [
    { archive: zip(package_entries()), badIndex: true },
    {
      archive: zip(
        package_entries().map((entry) =>
          entry.name === "termination.yaml"
            ? { ...entry, data: "termination_rule: {}\n" }
            : entry,
        ),
      ),
    },
    { archive: zip(package_entries()), commit: true },
  ];
  for (const item of cases) {
    const root = temporary();
    try {
      const old = write_config(
        join(root, "configs", "installed"),
        "installed",
        "a".repeat(64),
      );
      const old_manifest = readFileSync(join(old, "manifest.yaml"), "utf8");
      const current = manager(root, item.archive, {
        index: item.badIndex
          ? Buffer.from(
              JSON.stringify({
                format_version: 1,
                configs: [
                  {
                    id: "example",
                    name: "Example",
                    description: "Test",
                    download_url: "packages/example.zip",
                    sha256: "0".repeat(64),
                  },
                ],
              }),
            )
          : undefined,
        rename: item.commit
          ? (from, to) => {
              if (
                String(from).includes(`${join(".staging", "task", "example")}`)
              )
                throw new Error("commit failed");
              renameSync(from, to);
            }
          : undefined,
      });
      await current.refresh();
      await assert.rejects(() => current.install("example"));
      assert.equal(
        readFileSync(join(old, "manifest.yaml"), "utf8"),
        old_manifest,
      );
      assert.equal(
        JSON.parse(readFileSync(join(old, ".gachasimulate.json"), "utf8"))
          .sha256,
        "a".repeat(64),
      );
      assert.equal(
        existsSync(join(root, "configs", ".staging", "task")),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rejects unsafe ZIP entries and entry count overflow", async () => {
  const invalid: ZipEntry[][] = [
    [...package_entries(), { name: "../escape.yaml" }],
    [...package_entries(), { name: "/absolute.yaml" }],
    [...package_entries(), { name: "nested/file.yaml" }],
    [...package_entries(), { name: "directory/", mode: 0o040755 }],
    [...package_entries(), { name: "link.yaml", mode: 0o120777 }],
    [...package_entries(), { name: "pipe.yaml", mode: 0o010644 }],
    [...package_entries(), { name: "config.yaml" }],
    [...package_entries(), { name: "CONFIG.YAML" }],
    Array.from({ length: 65 }, (_, index) => ({ name: `file${index}.yaml` })),
  ];
  for (const entries of invalid) {
    const root = temporary();
    try {
      const archive = zip(entries);
      const current = manager(root, archive);
      await current.refresh();
      await assert.rejects(() => current.install("example"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("accepts a valid 64-entry ZIP", async () => {
  const root = temporary();
  try {
    const terminations = Array.from({ length: 62 }, (_, index) => ({
      file: `termination_${index}.yaml`,
      name: `Done ${index}`,
    }));
    const large_manifest = `id: example
name: Example
description: Test configuration
terminations:
${terminations
  .map(({ file, name }) => `  - file: ${file}\n    name: ${name}`)
  .join("\n")}
`;
    const archive = zip([
      { name: "manifest.yaml", data: large_manifest },
      { name: "config.yaml", data: config },
      ...terminations.map(({ file }) => ({
        name: file,
        data: termination,
      })),
    ]);
    const current = manager(root, archive);
    await current.refresh();
    await current.install("example");
    assert.equal(
      current.list_configs()[0]?.terminations.length,
      terminations.length,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a one-MiB entry but rejects one byte more", async () => {
  const root = temporary();
  try {
    const exact = zip(
      package_entries().map((entry) =>
        entry.name === "config.yaml"
          ? {
              ...entry,
              data: Buffer.concat([
                Buffer.from(config),
                Buffer.alloc(1024 * 1024 - Buffer.byteLength(config), 32),
              ]),
            }
          : entry,
      ),
    );
    const current = manager(root, exact);
    await current.refresh();
    await current.install("example");

    const oversized = zip([
      ...package_entries(),
      { name: "extra.yaml", data: Buffer.alloc(1024 * 1024 + 1) },
    ]);
    const rejected = manager(join(root, "other"), oversized);
    await rejected.refresh();
    await assert.rejects(() => rejected.install("example"), /1 MiB/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configuration changes reject simulation and concurrent mutations", async () => {
  const root = temporary();
  try {
    const archive = zip(package_entries());
    const blocked = manager(root, archive, { active: () => true });
    await assert.rejects(() => blocked.uninstall("example"), /simulation/);

    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const concurrent = new ConfigManager(join(root, "concurrent"), {
      download: async (url) => {
        if (url.endsWith("index.json")) return index_for(archive);
        await waiting;
        return archive;
      },
      simulation_active: () => false,
      random_uuid: () => "task",
    });
    await concurrent.refresh();
    const installing = concurrent.install("example");
    await assert.rejects(
      () => concurrent.uninstall("example"),
      /already running/,
    );
    release();
    await installing;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uninstall removes only the installed config with a colliding local id", async () => {
  const root = temporary();
  try {
    const archive = zip(package_entries());
    const local = join(root, "local");
    write_config(local, "local");
    const current = manager(root, archive);
    await current.set_local_directory(local);
    await current.refresh();
    await current.install("example");
    await current.uninstall("example");
    assert.equal(existsSync(join(local, "example", "config.yaml")), true);
    assert.equal(current.list_configs()[0]?.source, "local");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
