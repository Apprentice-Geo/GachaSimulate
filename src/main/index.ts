import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { cpus } from "node:os";
import { join } from "node:path";
import {
  scan_installed_configs,
  validate_installed_config_selection,
} from "./config_manager";
import { ResultEditor } from "./result_editor";
import { shutdown_native_processes, SimulationTask } from "./simulation";
import { validate_simulation_request } from "../shared/simulation";
import type { DisplayFields } from "../shared/result_editor";

let simulation: SimulationTask;
let result_editor: ResultEditor;
let quitting = false;

function shutdown(): Promise<void> {
  return shutdown_native_processes(simulation, result_editor);
}

function create_window(): void {
  const window = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.js"),
    },
  });

  window.on("close", (event) => {
    if (result_editor?.active && !simulation?.active) {
      event.preventDefault();
      if (quitting) return;
      quitting = true;
      void shutdown().then(
        () => window.destroy(),
        () => {
          quitting = false;
        },
      );
      return;
    }
    if (!simulation?.active) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void dialog
      .showMessageBox(window, {
        type: "warning",
        buttons: ["继续运行", "关闭并取消任务"],
        defaultId: 0,
        cancelId: 0,
        message: "模拟仍在运行，确定要关闭窗口吗？",
      })
      .then(async ({ response }) => {
        if (response !== 1) {
          quitting = false;
          return;
        }
        try {
          await shutdown();
          window.destroy();
        } catch (error) {
          quitting = false;
          await dialog.showMessageBox(window, {
            type: "error",
            buttons: ["确定"],
            message: "无法终止模拟进程",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      });
  });

  const renderer_url = process.env.ELECTRON_RENDERER_URL;
  if (renderer_url) {
    void window.loadURL(renderer_url);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  const installed_dir = join(app.getPath("userData"), "configs", "installed");
  const results_dir = join(app.getPath("userData"), "results");
  result_editor = new ResultEditor();
  simulation = new SimulationTask(
    installed_dir,
    results_dir,
    (event) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send("simulation-event", event);
    },
    { shutdown_native_processes: shutdown },
  );
  ipcMain.handle("list-installed-configs", () =>
    scan_installed_configs(installed_dir),
  );
  ipcMain.handle("get-logical-cpu-count", () => cpus().length);
  ipcMain.handle("start-simulation", (_event, request: unknown) => {
    validate_simulation_request(request, cpus().length);
    validate_installed_config_selection(
      installed_dir,
      request.configId,
      request.termination,
    );
    simulation.start(request);
  });
  ipcMain.handle("cancel-simulation", () => shutdown());
  ipcMain.handle("select-gsr-result", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "GachaSimulate 结果", extensions: ["gsr"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result_editor.open(result.filePaths[0]);
  });
  ipcMain.handle("save-result-fields", (_event, fields: DisplayFields) =>
    result_editor.save(fields),
  );
  ipcMain.handle("open-results-directory", async () => {
    const error = await shell.openPath(results_dir);
    if (error) throw new Error(error);
  });
  create_window();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      create_window();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (!simulation?.active && !result_editor?.active) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void shutdown().then(
    () => app.quit(),
    (error) => {
      quitting = false;
      dialog.showErrorBox(
        "无法退出 GachaSimulate",
        error instanceof Error ? error.message : String(error),
      );
    },
  );
});
