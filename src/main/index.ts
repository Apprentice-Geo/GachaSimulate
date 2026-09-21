import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  shell,
  type WebContents,
} from "electron";
import { execFile, spawn } from "node:child_process";
import { cpus } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ConfigManager } from "./config_manager";
import { download_https, type ConfigRequest } from "./config_download";
import { ResultEditor } from "./result_editor";
import { shutdown_native_processes, SimulationTask } from "./simulation";
import { validate_simulation_request } from "../shared/simulation";
import type { SaveResultFieldsRequest } from "../shared/result_editor";
import { UserRequestAdmission } from "./request_admission";
import { ExportTaskCoordinator } from "./export_task";
import { validate_export_task_request } from "../shared/export_task";

let simulation: SimulationTask;
let result_editor: ResultEditor;
let config_manager: ConfigManager;
let export_tasks: ExportTaskCoordinator;
let main_window: BrowserWindow | null = null;
const admission = new UserRequestAdmission();
let quitting = false;
const electron_offscreen = process.env.GACHASIMULATE_ELECTRON_OFFSCREEN === "1";

if (process.platform === "win32")
  // Windows 的字体缩放会影响设计好的 UI
  app.commandLine.appendSwitch("force-device-scale-factor", "1");

const exec_file = promisify(execFile);

async function open_directory(path: string): Promise<void> {
  if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
    try {
      const { stdout } = await exec_file("wslpath", ["-w", path]);
      await new Promise<void>((resolve, reject) => {
        const child = spawn("explorer.exe", [stdout.trim()], {
          detached: true,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
      return;
    } catch (error) {
      throw new Error(
        `WSL Explorer failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  const error = await shell.openPath(path);
  if (error) throw new Error(error);
}

function shutdown_native(): Promise<void> {
  return shutdown_native_processes(simulation, result_editor);
}

async function shutdown_all(): Promise<void> {
  admission.begin_shutdown();
  await Promise.all([shutdown_native(), export_tasks?.shutdown()]);
}

function create_window(): void {
  const window = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    ...(electron_offscreen ? { show: false } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.js"),
      ...(electron_offscreen
        ? { backgroundThrottling: false, offscreen: true }
        : {}),
    },
  });
  main_window = window;
  if (!app.isPackaged) {
    window.webContents.on("before-input-event", (event, input) => {
      if (
        input.type === "keyDown" &&
        !input.isAutoRepeat &&
        input.control &&
        input.shift &&
        !input.alt &&
        !input.meta &&
        input.key.toLowerCase() === "i"
      ) {
        event.preventDefault();
        window.webContents.toggleDevTools();
      }
    });
  }
  window.once("closed", () => {
    if (main_window === window) main_window = null;
  });

  window.on("close", (event) => {
    if (
      (result_editor?.active || export_tasks?.active) &&
      !simulation?.active
    ) {
      event.preventDefault();
      if (quitting) return;
      quitting = true;
      void shutdown_all().then(
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
          await shutdown_all();
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
  Menu.setApplicationMenu(null);

  const configs_dir = join(app.getPath("userData"), "configs");
  const results_dir = join(app.getPath("userData"), "results");
  result_editor = new ResultEditor();
  export_tasks = new ExportTaskCoordinator(
    result_editor,
    admission,
    (event) => {
      if (main_window && !main_window.isDestroyed())
        main_window.webContents.send("export-event", event);
    },
  );
  config_manager = new ConfigManager(configs_dir, {
    download: (url, limit) =>
      download_https(url, limit, net.request as unknown as ConfigRequest),
    simulation_active: () => simulation?.active ?? false,
  });
  simulation = new SimulationTask(
    config_manager.installed_dir,
    results_dir,
    (event) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send("simulation-event", event);
    },
    {
      local_dir: () => config_manager.local_dir,
      shutdown_native_processes: shutdown_native,
    },
  );
  ipcMain.handle("list-configs", () => config_manager.list_configs());
  ipcMain.handle("get-config-repository-state", () => config_manager.state());
  ipcMain.handle("refresh-config-repository", (_event, force: boolean) => {
    admission.admit("config-refresh");
    return config_manager.refresh(force === true);
  });
  ipcMain.handle("install-config", (_event, id: string) => {
    admission.admit("config-change");
    return config_manager.install(id);
  });
  ipcMain.handle("update-config", (_event, id: string) => {
    admission.admit("config-change");
    return config_manager.update(id);
  });
  ipcMain.handle("uninstall-config", (_event, id: string) => {
    admission.admit("config-change");
    return config_manager.uninstall(id);
  });
  ipcMain.handle("select-local-config-directory", async () => {
    admission.admit("config-change");
    if (simulation.active)
      throw new Error("local directory cannot change during simulation");
    if (config_manager.active)
      throw new Error("a configuration change is already running");
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0)
      return config_manager.state();
    return config_manager.set_local_directory(result.filePaths[0]);
  });
  ipcMain.handle("get-logical-cpu-count", () => cpus().length);
  ipcMain.handle("start-simulation", (_event, request: unknown) => {
    admission.admit("simulation");
    if (config_manager.active)
      throw new Error("simulation cannot start during a configuration change");
    validate_simulation_request(request, cpus().length);
    simulation.start(request);
  });
  ipcMain.handle("cancel-simulation", () => shutdown_native());
  ipcMain.handle("select-gsr-result", async () => {
    admission.admit("analysis");
    const result = await dialog.showOpenDialog({
      defaultPath: results_dir,
      properties: ["openFile"],
      filters: [{ name: "GachaSimulate 结果", extensions: ["gsr"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result_editor.open(result.filePaths[0]);
  });
  ipcMain.handle(
    "save-result-fields",
    (_event, request: SaveResultFieldsRequest) => {
      admission.admit("result-save");
      return result_editor.save(request);
    },
  );
  const assert_export_sender = (sender: WebContents) => {
    if (
      !main_window ||
      main_window.isDestroyed() ||
      sender !== main_window.webContents
    )
      throw new Error("export request came from an untrusted renderer");
  };
  ipcMain.handle("prepare-export", (event, request: unknown) => {
    assert_export_sender(event.sender);
    return export_tasks.prepare(request);
  });
  ipcMain.handle("select-export-destination", (event, request: unknown) => {
    assert_export_sender(event.sender);
    return export_tasks.select_destination(request, async () => {
      if (!main_window || main_window.isDestroyed())
        throw new Error("main window is unavailable");
      const result = await dialog.showOpenDialog(main_window, {
        properties: ["openDirectory"],
      });
      return result.canceled || result.filePaths.length === 0
        ? null
        : result.filePaths[0];
    });
  });
  ipcMain.handle("confirm-export-overwrite", (event, request: unknown) => {
    assert_export_sender(event.sender);
    return export_tasks.confirm_overwrite(request);
  });
  ipcMain.handle("cancel-export", (event, request: unknown) => {
    assert_export_sender(event.sender);
    return export_tasks.cancel(request);
  });
  ipcMain.handle("retry-export-cleanup", (event, request: unknown) => {
    assert_export_sender(event.sender);
    return export_tasks.retry_cleanup(request);
  });
  ipcMain.handle("open-export-directory", (event, request: unknown) => {
    assert_export_sender(event.sender);
    return export_tasks.open_directory(request, open_directory);
  });
  ipcMain.handle(
    "exit-after-export-cleanup",
    async (event, request: unknown) => {
      assert_export_sender(event.sender);
      validate_export_task_request(request);
      if (quitting) return;
      quitting = true;
      try {
        await export_tasks.retry_cleanup(request);
        const window = main_window;
        if (window && !window.isDestroyed()) window.destroy();
        await shutdown_all();
        app.quit();
      } catch (error) {
        quitting = false;
        throw error;
      }
    },
  );
  ipcMain.handle("open-results-directory", () => open_directory(results_dir));
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
  if (!simulation?.active && !result_editor?.active && !export_tasks?.active)
    return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void shutdown_all().then(
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
