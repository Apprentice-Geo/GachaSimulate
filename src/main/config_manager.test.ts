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
import test, { afterEach } from "node:test";
import {
  resolve_config_selection,
  scan_installed_configs,
  scan_local_configs,
} from "./config_snapshot";
import { ConfigManager } from "./config_manager";
import type { ConfigWork } from "./config_worker_protocol";
import type { LocalConfigSnapshot } from "./config_snapshot";
import { ShutdownCoordinator } from "./shutdown";
import { UserRequestAdmission } from "./request_admission";

const managers = new Set<ConfigManager>();
function tracked_manager(
  ...args: ConstructorParameters<typeof ConfigManager>
): ConfigManager {
  const value = new ConfigManager(...args);
  managers.add(value);
  return value;
}
afterEach(async () => {
  await Promise.all([...managers].map((value) => value.shutdown()));
  managers.clear();
});

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
  return tracked_manager(join(root, "configs"), {
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
    assert.match((await restarted.state()).localError ?? "", /不存在/);
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
    assert.equal((await current.state()).official[0]?.status, "available");
    write_config(join(configs, "installed"), "installed", digest);
    assert.equal((await current.state()).official[0]?.status, "installed");
    writeFileSync(
      join(configs, "installed", "example", ".gachasimulate.json"),
      JSON.stringify({ sha256: "f".repeat(64) }),
    );
    assert.equal(
      (await current.state()).official[0]?.status,
      "update_available",
    );
    const removed = manager(root, archive, {
      index: index_for(archive, false),
    });
    await removed.refresh();
    assert.equal((await removed.state()).official[0]?.status, "removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline refresh keeps installed configs available for use and uninstall", async () => {
  const root = temporary();
  try {
    write_config(join(root, "configs", "installed"), "installed");
    const current = tracked_manager(join(root, "configs"), {
      download: async () => {
        throw new Error("offline");
      },
      simulation_active: () => false,
    });
    const state = await current.refresh();
    assert.match(state.sourceError ?? "", /offline/);
    assert.equal(state.official[0]?.status, "installed");
    assert.equal((await current.list_configs())[0]?.source, "installed");
    await current.uninstall("example");
    assert.deepEqual(await current.list_configs(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refresh throttles automatic calls, merges concurrency, and allows force", async () => {
  const root = temporary();
  try {
    const archive = zip(package_entries());
    let downloads = 0;
    let current_time = 0;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const current = tracked_manager(join(root, "configs"), {
      download: async () => {
        downloads += 1;
        if (downloads === 1) await waiting;
        return index_for(archive);
      },
      simulation_active: () => false,
      now: () => current_time,
    });

    const first = current.refresh();
    const concurrent = current.refresh();
    release();
    await Promise.all([first, concurrent]);
    assert.equal(downloads, 1);

    await current.refresh();
    assert.equal(downloads, 1);
    await current.refresh(true);
    assert.equal(downloads, 2);

    current_time += 5 * 60 * 1_000;
    await current.refresh();
    assert.equal(downloads, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed refresh also throttles automatic retries", async () => {
  const root = temporary();
  try {
    let downloads = 0;
    const current = tracked_manager(join(root, "configs"), {
      download: async () => {
        downloads += 1;
        throw new Error("offline");
      },
      simulation_active: () => false,
      now: () => 0,
    });
    assert.match((await current.refresh()).sourceError ?? "", /offline/);
    await current.refresh();
    assert.equal(downloads, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const outcome of ["success", "failure"] as const) {
  test(`local directory changes preserve a pending official refresh ${outcome}`, async () => {
    const root = temporary();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let downloads = 0;
    const current = tracked_manager(join(root, "configs"), {
      download: async () => {
        downloads += 1;
        await waiting;
        if (outcome === "failure") throw new Error("offline");
        return index_for(zip(package_entries()));
      },
      simulation_active: () => false,
      now: () => 0,
    });
    try {
      const local = join(root, "local");
      mkdirSync(local);
      const refreshing = current.refresh();
      const changed = await current.set_local_directory(local);
      assert.equal(changed.localDirectory, local);
      assert.deepEqual(changed.official, []);
      release();
      const state = await refreshing;
      assert.equal(state.localDirectory, local);
      if (outcome === "success") {
        assert.equal(state.official[0]?.id, "example");
        assert.equal(state.sourceError, null);
      } else {
        assert.deepEqual(state.official, []);
        assert.match(state.sourceError ?? "", /offline/);
      }
      assert.deepEqual(await current.refresh(), state);
      assert.equal(downloads, 1, "completed refreshes retain their TTL");
    } finally {
      release();
      await current.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a forced official refresh does not invalidate an ongoing local scan", async () => {
  const root = temporary();
  const empty: LocalConfigSnapshot = {
    installed: [],
    local: [],
    local_error: null,
  };
  const scans: Array<(snapshot: LocalConfigSnapshot) => void> = [];
  const work: ConfigWork = {
    request: () =>
      new Promise<LocalConfigSnapshot>((resolve) =>
        scans.push(resolve),
      ) as never,
    stop: async () => undefined,
    resume: () => undefined,
  };
  const current = tracked_manager(join(root, "configs"), {
    download: async () => index_for(zip(package_entries())),
    simulation_active: () => false,
    config_work: work,
  });
  try {
    const listing = current.list_configs();
    const refreshing = current.refresh(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(scans.length, 2);
    scans[0](empty);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(scans.length, 2, "the original scan must remain usable");
    scans[1](empty);
    assert.deepEqual(await listing, []);
    assert.equal((await refreshing).official[0]?.id, "example");
  } finally {
    for (const resolve of scans) resolve(empty);
    await current.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refresh denied after download neither publishes nor throttles retry", async () => {
  const root = temporary();
  const body = index_for(zip(package_entries()));
  let release!: (value: Buffer) => void;
  const pending = new Promise<Buffer>((resolve) => {
    release = resolve;
  });
  let allowed = true;
  let downloads = 0;
  const current = tracked_manager(join(root, "configs"), {
    download: async () => (++downloads === 1 ? pending : body),
    simulation_active: () => false,
    now: () => 0,
    assert_request_allowed: () => {
      if (!allowed) throw new Error("refresh admission denied");
    },
  });
  try {
    const refreshing = current.refresh();
    const rejected = assert.rejects(refreshing, /admission denied/);
    allowed = false;
    release(body);
    await rejected;
    const state = await current.state();
    assert.deepEqual(state.official, []);
    assert.equal(state.sourceError, null);
    allowed = true;
    assert.equal((await current.refresh()).official[0]?.id, "example");
    assert.equal(downloads, 2);
  } finally {
    release(body);
    await current.shutdown();
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
    assert.equal((await current.list_configs())[0]?.source, "installed");
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
      (await current.list_configs())[0]?.terminations.length,
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
    const concurrent = tracked_manager(join(root, "concurrent"), {
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
    assert.equal((await current.list_configs())[0]?.source, "local");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scan from a previous local directory cannot publish after a directory change", async () => {
  const root = temporary();
  const scans: Array<(value: LocalConfigSnapshot) => void> = [];
  const work: ConfigWork = {
    request: () =>
      new Promise<LocalConfigSnapshot>((resolve) =>
        scans.push(resolve),
      ) as never,
    stop: async () => undefined,
    resume: () => undefined,
  };
  try {
    const local = join(root, "local");
    mkdirSync(local);
    const current = tracked_manager(join(root, "configs"), {
      download: async () => index_for(zip(package_entries())),
      simulation_active: () => false,
      config_work: work,
    });
    const previous = current.state();
    const changing = current.set_local_directory(local);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(scans.length, 2);
    scans[1]({ installed: [], local: [], local_error: null });
    await changing;
    scans[0]({ installed: [], local: [], local_error: "obsolete directory" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(scans.length, 3);
    scans[2]({ installed: [], local: [], local_error: null });
    assert.equal((await previous).localDirectory, local);
    assert.equal((await previous).localError, null);
    const a = current.list_configs();
    const b = current.state();
    assert.equal(
      scans.length,
      5,
      "a later query must read anew rather than reuse an older in-flight scan",
    );
    scans[3]({ installed: [], local: [], local_error: null });
    scans[4]({ installed: [], local: [], local_error: null });
    await Promise.all([a, b]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown waits for an admitted install download and prevents its late commit", async () => {
  const root = temporary();
  const archive = zip(package_entries());
  let release!: (body: Buffer) => void;
  const download = new Promise<Buffer>((resolve) => {
    release = resolve;
  });
  try {
    const current = tracked_manager(join(root, "configs"), {
      download: async (url) =>
        url.endsWith("index.json") ? index_for(archive) : download,
      simulation_active: () => false,
    });
    await current.refresh();
    const installing = current.install("example");
    const rejected = assert.rejects(installing, /shutdown/);
    let stopped = false;
    const stopping = current.shutdown().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    await assert.rejects(current.list_configs(), /shutdown/);
    release(archive);
    await Promise.all([rejected, stopping]);
    assert.equal(existsSync(join(current.installed_dir, "example")), false);
    assert.equal(current.active, false);
    current.resume();
    assert.deepEqual(await current.list_configs(), []);
    await current.install("example");
    assert.equal((await current.list_configs()).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed worker stop still waits for refresh settlement before recovery", async () => {
  const root = temporary();
  let release!: (body: Buffer) => void;
  const download = new Promise<Buffer>((resolve) => {
    release = resolve;
  });
  let resumes = 0;
  const work: ConfigWork = {
    request: async () =>
      ({ installed: [], local: [], local_error: null }) as never,
    stop: async () => {
      throw new Error("worker cannot stop");
    },
    resume: () => {
      resumes += 1;
    },
  };
  const current = new ConfigManager(join(root, "configs"), {
    download: () => download,
    simulation_active: () => false,
    config_work: work,
  });
  try {
    const refreshing = current.refresh();
    const rejected_refresh = assert.rejects(refreshing, /shutdown/);
    let finished = false;
    const stopped = assert
      .rejects(current.shutdown(), /worker cannot stop/)
      .then(() => {
        finished = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    release(index_for(zip(package_entries())));
    await Promise.all([stopped, rejected_refresh]);
    await assert.rejects(current.state(), /shutdown/);
    current.resume();
    assert.equal(resumes, 1);
    assert.deepEqual(await current.list_configs(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown times out a stalled install, retains its owner, and rejects its late commit after recovery", async () => {
  const root = temporary();
  const archive = zip(package_entries());
  let release!: (body: Buffer) => void;
  const download = new Promise<Buffer>((resolve) => {
    release = resolve;
  });
  const admission = new UserRequestAdmission();
  const current = tracked_manager(join(root, "configs"), {
    download: async (url) =>
      url.endsWith("index.json") ? index_for(archive) : download,
    simulation_active: () => false,
    assert_request_allowed: (kind) => admission.admit(kind),
    shutdown_timeout_ms: 10,
  });
  const shutdown = new ShutdownCoordinator(
    admission,
    [() => current.shutdown()],
    () => current.resume(),
  );
  try {
    await current.refresh();
    const installing = current.install("example");
    const rejected_install = assert.rejects(
      installing,
      /directory has changed/,
    );
    await assert.rejects(
      shutdown.stop(),
      /configuration change settlement timed out/,
    );
    assert.equal(current.active, true);
    admission.admit("analysis");
    assert.deepEqual(await current.list_configs(), []);
    await assert.rejects(current.uninstall("example"), /already running/);
    release(archive);
    await rejected_install;
    assert.equal(existsSync(join(current.installed_dir, "example")), false);
    assert.equal(current.active, false);
    await current.install("example");
    assert.equal((await current.list_configs()).length, 1);
    await shutdown.stop();
  } finally {
    release(archive);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const outcome of ["success", "failure"] as const) {
  test(`shutdown rejects a late refresh ${outcome} after recovery without throttling retry`, async () => {
    const root = temporary();
    const body = index_for(zip(package_entries()));
    let release!: (value: Buffer) => void;
    const download = new Promise<Buffer>((resolve, reject) => {
      release = (value) => {
        if (outcome === "success") resolve(value);
        else reject(new Error("late offline error"));
      };
    });
    let downloads = 0;
    const admission = new UserRequestAdmission();
    const current = tracked_manager(join(root, "configs"), {
      download: async () => {
        downloads += 1;
        return downloads === 1 ? download : body;
      },
      simulation_active: () => false,
      assert_request_allowed: (kind) => admission.admit(kind),
      shutdown_timeout_ms: 10,
    });
    const shutdown = new ShutdownCoordinator(
      admission,
      [() => current.shutdown()],
      () => current.resume(),
    );
    try {
      const refreshing = current.refresh();
      const rejected_refresh = assert.rejects(refreshing, /refresh.*shutdown/);
      await assert.rejects(
        shutdown.stop(),
        /configuration refresh settlement timed out/,
      );
      admission.admit("analysis");
      assert.deepEqual((await current.state()).official, []);
      const joined = current.refresh(true);
      const rejected_joined = assert.rejects(joined, /refresh.*shutdown/);
      assert.equal(downloads, 1);
      release(body);
      await Promise.all([rejected_refresh, rejected_joined]);
      const state = await current.state();
      assert.deepEqual(state.official, []);
      assert.equal(state.sourceError, null);
      assert.equal((await current.refresh()).official.length, 1);
      assert.equal(downloads, 2);
      await shutdown.stop();
    } finally {
      release(body);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
