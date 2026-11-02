import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { _electron as electron } from "playwright";
import { result_fixture } from "./ui_fixtures";
import type { DesktopExportEvent } from "../shared/export_task";

async function launch_desktop_harness(enable_subframes = false) {
  const directory = await mkdtemp(join(tmpdir(), "gachasimulate-desktop-ipc-"));
  const profile = join(directory, "profile");
  const config = join(profile, "configs", "installed", "test");
  await mkdir(config, { recursive: true });
  await cp(join(process.cwd(), "test-fixtures/configs/test"), config, {
    recursive: true,
  });
  await writeFile(
    join(config, ".gachasimulate.json"),
    JSON.stringify({ sha256: "a".repeat(64) }),
  );
  const harness = join(directory, "main.cjs");
  const analysis = result_fixture().analysis;
  await writeFile(
    harness,
    `
    const electron = require("electron");
    const { app, BrowserWindow, dialog } = electron;
    const { EventEmitter } = require("node:events");
    const { PassThrough } = require("node:stream");
    const Module = require("node:module");
    const processes = require("node:child_process");
    const state = globalThis.desktopTest = { errors: [], fail_cleanup: false, cleanup_attempts: 0, sends: [], navigation: [], main_id: null };
    Object.defineProperty(process, "resourcesPath", { value: ${JSON.stringify(join(process.cwd(), "build"))} });
    // This harness alone enables child-frame preload execution so a real child
    // can invoke IPC; production keeps nodeIntegrationInSubFrames disabled.
    const TestWindow = new Proxy(BrowserWindow, {
      construct(Target, [options]) {
        const prepared = String(options.webPreferences?.preload).endsWith("index.js")
          ? { ...options, webPreferences: { ...options.webPreferences, nodeIntegrationInSubFrames: true } }
          : options;
        return new Target(prepared);
      },
    });
    const load = Module._load;
    Module._load = function(name, ...args) {
      const loaded = load.call(this, name, ...args);
      return ${enable_subframes} && name === "electron" ? new Proxy(loaded, { get(target, key) { return key === "BrowserWindow" ? TestWindow : target[key]; } }) : loaded;
    };
    app.on("browser-window-created", (_event, window) => {
      if (state.main_id === null) state.main_id = window.id;
      const send = window.webContents.send.bind(window.webContents);
      window.webContents.send = (channel, ...args) => { state.sends.push({ id: window.id, channel }); return send(channel, ...args); };
      window.webContents.on("will-navigate", (event, url) => queueMicrotask(() => state.navigation.push({ url, blocked: event.defaultPrevented })));
    });
    const destroy = BrowserWindow.prototype.destroy;
    BrowserWindow.prototype.destroy = function() {
      if (String(this.webContents.getURL()).includes("export.html")) {
        state.cleanup_attempts += 1;
        if (state.fail_cleanup) throw new Error("injected export window cleanup failure");
      }
      return destroy.call(this);
    };
    const realSpawn = processes.spawn;
    processes.spawn = (command, ...args) => {
      if (!String(command).includes("gachasimulate-")) return realSpawn(command, ...args);
      const child = Object.assign(new EventEmitter(), { pid: 123456789, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        child.stdout.write(String(command).includes("-analyze") ? ${JSON.stringify(JSON.stringify(analysis))} : '{"type":"started"}\\n');
        child.exitCode = String(command).includes("-analyze") ? 0 : 1;
        child.emit("close", child.exitCode);
      });
      return child;
    };
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.properties.includes("openDirectory") ? ${JSON.stringify(directory)} : ${JSON.stringify(join(directory, "result.gsr"))}] });
    dialog.showMessageBox = async () => ({ response: 1 });
    dialog.showErrorBox = (_title, detail) => state.errors.push(detail);
    require(${JSON.stringify(join(process.cwd(), "out/main/index.js"))});
  `,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({
    args: [harness],
    cwd: process.cwd(),
    env: {
      ...env,
      GACHASIMULATE_ELECTRON_OFFSCREEN: "1",
      XDG_CONFIG_HOME: profile,
    },
  });
  const page = await application.firstWindow();
  await page.waitForFunction(() => !!window.desktopApi);
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const state = (
      globalThis as never as {
        desktopTest: {
          main_id: number;
          navigation: Array<{ url: string; blocked: boolean }>;
        };
      }
    ).desktopTest;
    state.main_id = window.id;
    window.webContents.on("will-navigate", (event, url) =>
      queueMicrotask(() =>
        state.navigation.push({ url, blocked: event.defaultPrevented }),
      ),
    );
  });
  return { application, page, directory };
}

test("production desktop IPC validates requests, rejects other windows and child frames, and contains navigation", async () => {
  const { application, page, directory } = await launch_desktop_harness(true);
  try {
    assert.ok(
      (await page.evaluate(() => window.desktopApi.getLogicalCpuCount())) > 0,
    );
    const opened = await page.evaluate(() =>
      window.desktopApi.selectGsrResult(),
    );
    assert.ok(opened);
    const saved = await page.evaluate(
      (request) => window.desktopApi.saveResultFields(request),
      {
        session_id: opened.session_id,
        fields: { ...opened.fields, title: "IPC roundtrip" },
      },
    );
    assert.deepEqual(Object.keys(saved).sort(), ["display", "session_id"]);
    assert.equal(saved.display.title, "IPC roundtrip");
    await assert.rejects(
      page.evaluate(() =>
        window.desktopApi.installConfig(42 as unknown as string),
      ),
      /invalid configuration id/,
    );
    await assert.rejects(
      application.evaluate(
        async ({ BrowserWindow }, paths) => {
          const other = new BrowserWindow({
            show: false,
            webPreferences: {
              preload: paths.preload,
              contextIsolation: true,
              nodeIntegration: false,
            },
          });
          try {
            await other.loadFile(paths.html);
            await other.webContents.executeJavaScript(
              "window.desktopApi.getLogicalCpuCount()",
            );
          } finally {
            other.destroy();
          }
        },
        {
          preload: join(process.cwd(), "out/preload/index.js"),
          html: join(process.cwd(), "out/renderer/index.html"),
        },
      ),
      /untrusted renderer/,
    );
    await page.evaluate(() => {
      const child = document.createElement("iframe");
      child.src = window.location.href;
      document.body.append(child);
    });
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLIFrameElement>("iframe")?.contentWindow
          ?.desktopApi !== undefined,
    );
    const child = page.frames().find((frame) => frame !== page.mainFrame())!;
    await assert.rejects(
      child.evaluate(() => window.desktopApi.getLogicalCpuCount()),
      /untrusted renderer/,
    );
    await page.evaluate(() => document.querySelector("iframe")?.remove());

    const auxiliary_id = await application.evaluate(
      async ({ BrowserWindow }, paths) => {
        const auxiliary = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: paths.preload,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        await auxiliary.loadFile(paths.html);
        return auxiliary.id;
      },
      {
        preload: join(process.cwd(), "out/preload/export.js"),
        html: join(process.cwd(), "out/renderer/export.html"),
      },
    );
    await page.evaluate(() =>
      window.desktopApi.startSimulation({
        configSource: "installed",
        configId: "test",
        termination: "termination.yaml",
        resultItem: "draw_count",
        target: { kind: "totalRuns", value: 1 },
        seed: 0,
        threads: 1,
      }),
    );
    const simulation_sends = await application.evaluate(() =>
      (
        globalThis as never as {
          desktopTest: { sends: Array<{ id: number; channel: string }> };
        }
      ).desktopTest.sends.filter(
        ({ channel }) => channel === "simulation-event",
      ),
    );
    assert.ok(simulation_sends.length >= 2);
    assert.equal(
      simulation_sends.some(({ id }) => id === auxiliary_id),
      false,
    );
    await application.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.fromId(id)?.destroy();
    }, auxiliary_id);

    const trusted_url = page.url();
    await page.evaluate(() => {
      window.location.href = "http://127.0.0.1:9/foreign";
    });
    const navigation = await application.evaluate(async () => {
      const state = (
        globalThis as never as {
          desktopTest: { navigation: Array<{ blocked: boolean }> };
        }
      ).desktopTest;
      const deadline = Date.now() + 5000;
      while (!state.navigation.length) {
        if (Date.now() > deadline)
          throw new Error("navigation guard was not exercised");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return state.navigation.at(-1)!;
    });
    assert.equal(navigation.blocked, true);
    assert.equal(page.url(), trusted_url);
    // Main-initiated navigation bypasses will-navigate; sender URL remains guarded.
    await application.evaluate(async ({ BrowserWindow }) => {
      await BrowserWindow.getAllWindows()[0].loadURL(
        "data:text/html,<html><body>foreign</body></html>",
      );
    });
    await page.waitForFunction(() => !!window.desktopApi);
    await assert.rejects(
      page.evaluate(() => window.desktopApi.getLogicalCpuCount()),
      /untrusted renderer/,
    );
  } finally {
    await application
      .evaluate(() => {
        (
          globalThis as never as { desktopTest: { fail_cleanup: boolean } }
        ).desktopTest.fail_cleanup = false;
      })
      .catch(() => undefined);
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real export cleanup failures retain the desktop and owner across both exit entries", async () => {
  const { application, page, directory } = await launch_desktop_harness();
  try {
    await application.evaluate(() => {
      (
        globalThis as never as { desktopTest: { fail_cleanup: boolean } }
      ).desktopTest.fail_cleanup = true;
    });
    const opened = await page.evaluate(() =>
      window.desktopApi.selectGsrResult(),
    );
    assert.ok(opened);
    await page.evaluate(() => {
      (window as never as { exportEvents: DesktopExportEvent[] }).exportEvents =
        [];
      window.desktopApi.onExportEvent((event) =>
        (
          window as never as { exportEvents: DesktopExportEvent[] }
        ).exportEvents.push(event),
      );
    });
    const { reservation_id } = await page.evaluate(
      (session_id) =>
        window.desktopApi.prepareExport({
          session_id,
          formats: ["png"],
          base_name: "cleanup",
        }),
      opened.session_id,
    );
    await page.waitForFunction(() =>
      (
        window as never as { exportEvents: DesktopExportEvent[] }
      ).exportEvents.some(({ type }) => type === "preparation-ready"),
    );
    const selected = await page.evaluate(
      (reservation_id) =>
        window.desktopApi.selectExportDestination({ reservation_id }),
      reservation_id,
    );
    assert.equal(selected.status, "started");
    if (selected.status !== "started") throw new Error("export did not start");
    const task_id = selected.task_id;
    await page.waitForFunction(
      () =>
        (
          window as never as { exportEvents: DesktopExportEvent[] }
        ).exportEvents.some(
          (event) =>
            "cleanup_status" in event && event.cleanup_status === "blocked",
        ),
      undefined,
      { timeout: 30000 },
    );
    await application.evaluate(({ BrowserWindow }) => {
      const state = (
        globalThis as never as { desktopTest: { main_id: number } }
      ).desktopTest;
      BrowserWindow.fromId(state.main_id)!.close();
    });
    await application.evaluate(async () => {
      const state = (
        globalThis as never as { desktopTest: { errors: string[] } }
      ).desktopTest;
      const deadline = Date.now() + 5000;
      while (!state.errors.length) {
        if (Date.now() > deadline)
          throw new Error("close failure was not reported");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    assert.equal(page.isClosed(), false);
    await assert.rejects(
      page.evaluate(() => window.desktopApi.selectGsrResult()),
      /during export/,
    );
    await assert.rejects(
      page.evaluate(
        (task_id) => window.desktopApi.exitAfterExportCleanup({ task_id }),
        task_id,
      ),
      /cleanup/,
    );
    assert.equal(page.isClosed(), false);
    await assert.rejects(
      page.evaluate(() => window.desktopApi.selectGsrResult()),
      /during export/,
    );
    await application.evaluate(() => {
      (
        globalThis as never as { desktopTest: { fail_cleanup: boolean } }
      ).desktopTest.fail_cleanup = false;
    });
    await page.evaluate(
      (task_id) => window.desktopApi.retryExportCleanup({ task_id }),
      task_id,
    );
    assert.ok(await page.evaluate(() => window.desktopApi.selectGsrResult()));
  } finally {
    await application
      .evaluate(() => {
        (
          globalThis as never as { desktopTest: { fail_cleanup: boolean } }
        ).desktopTest.fail_cleanup = false;
      })
      .catch(() => undefined);
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
