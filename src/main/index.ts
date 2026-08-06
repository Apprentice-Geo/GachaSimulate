import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import {
  initialize_installed_configs,
  scan_installed_configs,
} from "./config_manager";
import { SimulationTask } from "./simulation";
import type { SimulationRequest } from "../shared/simulation";

let simulation: SimulationTask;
let quitting = false;

function create_window(): void {
  const window = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.js"),
    },
  });

  window.on("close", (event) => {
    if (!simulation?.active || quitting) return;
    event.preventDefault();
    void dialog.showMessageBox(window, {
      type: "warning",
      buttons: ["继续运行", "关闭并取消任务"],
      defaultId: 0,
      cancelId: 0,
      message: "模拟仍在运行，确定要关闭窗口吗？",
    }).then(({ response }) => {
      if (response !== 1) return;
      quitting = true;
      void simulation.cancel_and_wait().then(() => window.destroy());
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
  initialize_installed_configs(
    installed_dir,
    join(process.cwd(), "configs", "presets"),
  );
  const results_dir = join(app.getPath("userData"), "results");
  simulation = new SimulationTask(installed_dir, results_dir, (event) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send("simulation-event", event);
  });
  ipcMain.handle("list-installed-configs", () =>
    scan_installed_configs(installed_dir),
  );
  ipcMain.handle("start-simulation", (_event, request: SimulationRequest) => {
    if (!scan_installed_configs(installed_dir).some((config) => config.id === request.configId))
      throw new Error("installed config not found");
    simulation.start(request);
  });
  ipcMain.handle("cancel-simulation", () => simulation.cancel());
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
