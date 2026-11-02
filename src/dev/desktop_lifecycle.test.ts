import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { _electron as electron } from "playwright";
import { result_fixture } from "./ui_fixtures";
import type {
  SavedResultFields,
  SaveResultFieldsRequest,
} from "../shared/result_editor";

test("delayed saves cannot restore a previous session or replace a returning page draft", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gachasimulate-save-order-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({
    args: [process.cwd()],
    cwd: process.cwd(),
    env: {
      ...env,
      GACHASIMULATE_ELECTRON_OFFSCREEN: "1",
      XDG_CONFIG_HOME: directory,
    },
  });
  try {
    const page = await application.firstWindow();
    for (const outcome of ["new-session", "new-draft"] as const) {
      const first = structuredClone(result_fixture());
      first.session_id = "A";
      first.fields.title = first.display.title = "A original";
      const second = structuredClone(first);
      second.session_id = "B";
      second.fields.title = second.display.title = "B original";
      await application.evaluate(
        ({ ipcMain }, fixtures) => {
          const pending: Array<{
            request: SaveResultFieldsRequest;
            resolve: (saved: SavedResultFields) => void;
          }> = [];
          (
            globalThis as never as { saveOrder: { pending: typeof pending } }
          ).saveOrder = { pending };
          ipcMain.removeHandler("select-gsr-result");
          ipcMain.handle("select-gsr-result", () => fixtures.shift());
          ipcMain.removeHandler("save-result-fields");
          ipcMain.handle(
            "save-result-fields",
            (_event, request: SaveResultFieldsRequest) =>
              new Promise<SavedResultFields>((resolve) =>
                pending.push({ request, resolve }),
              ),
          );
        },
        [first, second],
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "结果编辑", exact: true }).click();
      await page.getByRole("button", { name: "选择 GSR", exact: true }).click();
      await page.getByLabel("标题", { exact: true }).fill("A saved");
      await page
        .getByRole("button", { name: "结果可视化", exact: true })
        .click();
      await application.evaluate(async () => {
        const state = (
          globalThis as never as { saveOrder: { pending: unknown[] } }
        ).saveOrder;
        const deadline = Date.now() + 5000;
        while (!state.pending.length) {
          if (Date.now() > deadline)
            throw new Error("blur save did not reach main");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      });
      if (outcome === "new-session") {
        await page
          .getByRole("button", { name: "更换结果", exact: true })
          .click();
        await page.locator('[data-testid="visualize-root"]').waitFor();
      }
      await page.getByRole("button", { name: "结果编辑", exact: true }).click();
      if (outcome === "new-draft")
        await page.getByLabel("标题", { exact: true }).fill("A newer draft");
      await application.evaluate(() => {
        const state = (
          globalThis as never as {
            saveOrder: {
              pending: Array<{
                request: SaveResultFieldsRequest;
                resolve: (saved: SavedResultFields) => void;
              }>;
            };
          }
        ).saveOrder;
        const saved = state.pending.shift()!;
        saved.resolve({
          session_id: saved.request.session_id,
          display: { display_version: 2, ...saved.request.fields },
        });
      });
      // An IPC round trip plus a frame lets the delayed response reach React.
      await page.evaluate(async () => {
        await window.desktopApi.getLogicalCpuCount();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      assert.equal(
        await page.getByLabel("标题", { exact: true }).inputValue(),
        outcome === "new-session" ? "B original" : "A newer draft",
      );
    }
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("renderer rejects unrenderable loads before publishing and can load again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gachasimulate-load-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({
    args: [process.cwd()],
    cwd: process.cwd(),
    env: {
      ...env,
      GACHASIMULATE_ELECTRON_OFFSCREEN: "1",
      XDG_CONFIG_HOME: directory,
    },
  });
  try {
    const first = result_fixture();
    const invalid = structuredClone(first);
    invalid.session_id = "invalid";
    invalid.analysis.totals.result = "9007199254740992";
    const next = structuredClone(first);
    next.session_id = "next";
    next.fields.title = next.display.title = "recovered result";
    await application.evaluate(
      ({ ipcMain }, inputs) => {
        ipcMain.removeHandler("select-gsr-result");
        ipcMain.handle("select-gsr-result", () => inputs.shift());
      },
      [first, invalid, next],
    );
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "结果可视化", exact: true }).click();
    await page.getByRole("button", { name: "选择 GSR", exact: true }).click();
    await page.locator('[data-testid="visualize-root"]').waitFor();
    await page.getByRole("button", { name: "更换结果", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "supported visualization range" })
      .waitFor();
    assert.equal(
      await page.locator('[data-testid="visualize-root"]').count(),
      1,
    );
    await page.getByRole("button", { name: "结果编辑", exact: true }).click();
    assert.equal(
      await page.getByLabel("标题", { exact: true }).inputValue(),
      first.fields.title,
    );
    await page.getByRole("button", { name: "更换 GSR", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="标题"]',
        )?.value === "recovered result",
    );
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real desktop close and before-quit recover after injected termination failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gachasimulate-shutdown-"));
  const harness = join(directory, "main.cjs");
  const fixture = result_fixture();
  await writeFile(
    harness,
    `
    const { EventEmitter } = require("node:events");
    const { PassThrough } = require("node:stream");
    const { app, dialog } = require("electron");
    Object.defineProperty(process, "resourcesPath", { value: ${JSON.stringify(join(process.cwd(), "build"))} });
    const processes = require("node:child_process");
    const realSpawn = processes.spawn;
    const state = globalThis.shutdownTest = { errors: [], terminations: 0, finish: null, child: null };
    processes.spawn = (command, ...args) => {
      if (!String(command).includes("gachasimulate-analyze")) return realSpawn(command, ...args);
      const child = Object.assign(new EventEmitter(), { pid: 123456789, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      state.child = child;
      return child;
    };
    processes.execFile = (_command, _args, _options, callback) => {
      state.terminations += 1;
      state.finish = () => callback(new Error("injected termination failure"), "", "");
    };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(fixture.path)}] });
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
      XDG_CONFIG_HOME: join(directory, "profile"),
    },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(() => !!window.desktopApi);
    await page.evaluate(() => {
      void window.desktopApi.selectGsrResult().catch((reason) => {
        document.body.dataset.loadError = String(reason);
      });
    });
    assert.equal(
      await application.evaluate(() => process.resourcesPath),
      join(process.cwd(), "build"),
    );
    await application.evaluate(async () => {
      const state = (
        globalThis as never as { shutdownTest: { child: unknown } }
      ).shutdownTest;
      const deadline = Date.now() + 5000;
      while (!state.child) {
        if (Date.now() > deadline)
          throw new Error("injected analyzer did not start");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    for (const entry of ["close", "before-quit"] as const) {
      await application.evaluate(({ app, BrowserWindow }, kind) => {
        if (kind === "close") {
          BrowserWindow.getAllWindows()[0].close();
          BrowserWindow.getAllWindows()[0].close();
        } else {
          app.quit();
          app.quit();
        }
      }, entry);
      const expected = entry === "close" ? 1 : 2;
      await application.evaluate(async (_, count) => {
        const state = (
          globalThis as never as {
            shutdownTest: { terminations: number; finish: (() => void) | null };
          }
        ).shutdownTest;
        const deadline = Date.now() + 5000;
        while (state.terminations < count) {
          if (Date.now() > deadline)
            throw new Error("termination was not requested");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        state.finish!();
      }, expected);
      await application.evaluate(async (_, count) => {
        const state = (
          globalThis as never as { shutdownTest: { errors: string[] } }
        ).shutdownTest;
        const deadline = Date.now() + 5000;
        while (state.errors.length < count) {
          if (Date.now() > deadline)
            throw new Error("shutdown failure was not reported");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }, expected);
      assert.equal(
        await application.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
        1,
      );
      assert.equal(
        await application.evaluate(
          () =>
            (globalThis as never as { shutdownTest: { terminations: number } })
              .shutdownTest.terminations,
        ),
        expected,
      );
      const error = await page.evaluate(async (fields) => {
        try {
          await window.desktopApi.saveResultFields({
            session_id: "missing-session",
            fields,
          });
          return "unexpected success";
        } catch (reason) {
          return String(reason);
        }
      }, fixture.fields);
      assert.match(error, /result session has changed/);
    }
  } finally {
    // Finish the injected process before normal application teardown.
    await application
      .evaluate(() => {
        const state = (
          globalThis as never as {
            shutdownTest: {
              child: { emit(event: string, code: number): void };
            };
          }
        ).shutdownTest;
        state.child.emit("close", 1);
      })
      .catch(() => undefined);
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
