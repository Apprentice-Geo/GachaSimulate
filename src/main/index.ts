import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  shell,
} from "electron";
import { cpus } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigManager } from "./config_manager";
import { download_https, type ConfigRequest } from "./config_download";
import { ResultEditor } from "./result_editor";
import { shutdown_native_processes, SimulationTask } from "./simulation";
import { UserRequestAdmission } from "./request_admission";
import { ExportTaskCoordinator } from "./export_task";
import { app_links } from "../shared/app_info";
import { DesktopIpc, protect_desktop_navigation } from "./desktop_ipc";
import { ShutdownCoordinator } from "./shutdown";

let simulation: SimulationTask;
let result_editor: ResultEditor;
let config_manager: ConfigManager;
let export_tasks: ExportTaskCoordinator;
let main_window: BrowserWindow | null = null;
const desktop_url =
  process.env.ELECTRON_RENDERER_URL ??
  pathToFileURL(join(__dirname, "../renderer/index.html")).href;
const desktop_ipc = new DesktopIpc(ipcMain, () => main_window, desktop_url);
const admission = new UserRequestAdmission();
let exit_committed = false;
let exit_request: Promise<void> | null = null;
const shutdown = new ShutdownCoordinator(
  admission,
  [
    async () => {
      await config_manager?.shutdown();
    },
    () => shutdown_native(),
    async () => {
      await export_tasks?.shutdown();
    },
  ],
  () => config_manager?.resume(),
);
const electron_offscreen = process.env.GACHASIMULATE_ELECTRON_OFFSCREEN === "1";
// Automation already supplies a temporary profile; isolate persisted UI settings too.
if (electron_offscreen && process.env.XDG_CONFIG_HOME)
  app.setPath("userData", process.env.XDG_CONFIG_HOME);

if (process.platform === "win32")
  // Windows 的字体缩放会影响设计好的 UI
  app.commandLine.appendSwitch("force-device-scale-factor", "1");

async function open_directory(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
}

function shutdown_native(): Promise<void> {
  return shutdown_native_processes(simulation, result_editor);
}

function request_exit(before_shutdown?: () => Promise<void>): Promise<void> {
  if (exit_request) return exit_request;
  const operation = (async () => {
    const window = main_window;
    if (simulation?.active && window && !window.isDestroyed()) {
      const { response } = await dialog.showMessageBox(window, {
        type: "warning",
        buttons: ["继续运行", "关闭并取消任务"],
        defaultId: 0,
        cancelId: 0,
        message: "模拟仍在运行，确定要关闭窗口吗？",
      });
      if (response !== 1) return;
    }
    await before_shutdown?.();
    await shutdown.stop();
    exit_committed = true;
    if (window && !window.isDestroyed()) window.destroy();
    app.quit();
  })().catch((error) => {
    dialog.showErrorBox(
      "无法退出 GachaSimulate",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  });
  exit_request = operation;
  void operation
    .finally(() => {
      if (exit_request === operation) exit_request = null;
    })
    .catch(() => undefined);
  return operation;
}

function require_main_window(): BrowserWindow {
  if (!main_window || main_window.isDestroyed())
    throw new Error("main window is unavailable");
  return main_window;
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
  protect_desktop_navigation(window, desktop_url);
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
    if (exit_committed) return;
    event.preventDefault();
    void request_exit().catch(() => undefined);
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
  result_editor = new ResultEditor({
    assert_open_allowed: () => admission.admit("analysis"),
  });
  export_tasks = new ExportTaskCoordinator(result_editor, admission, (event) =>
    desktop_ipc.send("export-event", event),
  );
  config_manager = new ConfigManager(configs_dir, {
    download: (url, limit) =>
      download_https(url, limit, net.request as unknown as ConfigRequest),
    simulation_active: () => simulation?.active ?? false,
    assert_request_allowed: (kind) => admission.admit(kind),
  });
  simulation = new SimulationTask(
    config_manager.installed_dir,
    results_dir,
    (event) => desktop_ipc.send("simulation-event", event),
    {
      local_dir: () => config_manager.local_dir,
      shutdown_native_processes: shutdown_native,
      prepare_program: (request) => config_manager.compile_selection(request),
      assert_start_allowed: () => admission.admit("simulation"),
    },
  );
  desktop_ipc.handle("list-configs", () => config_manager.list_configs());
  desktop_ipc.handle("open-app-link", (link) =>
    shell.openExternal(app_links[link]),
  );
  desktop_ipc.handle("get-config-repository-state", () =>
    config_manager.state(),
  );
  desktop_ipc.handle("refresh-config-repository", (force) => {
    admission.admit("config-refresh");
    return config_manager.refresh(force === true);
  });
  desktop_ipc.handle("install-config", (id) => {
    admission.admit("config-change");
    return config_manager.install(id);
  });
  desktop_ipc.handle("update-config", (id) => {
    admission.admit("config-change");
    return config_manager.update(id);
  });
  desktop_ipc.handle("uninstall-config", (id) => {
    admission.admit("config-change");
    return config_manager.uninstall(id);
  });
  desktop_ipc.handle("select-local-config-directory", async () => {
    admission.admit("config-change");
    if (simulation.active)
      throw new Error("local directory cannot change during simulation");
    if (config_manager.active)
      throw new Error("a configuration change is already running");
    const result = await dialog.showOpenDialog(require_main_window(), {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0)
      return config_manager.state();
    admission.admit("config-change");
    if (simulation.active)
      throw new Error("local directory cannot change during simulation");
    if (config_manager.active)
      throw new Error("a configuration change is already running");
    return config_manager.set_local_directory(result.filePaths[0]);
  });
  desktop_ipc.handle("get-logical-cpu-count", () => cpus().length);
  desktop_ipc.handle("start-simulation", (request) => {
    admission.admit("simulation");
    if (config_manager.active)
      throw new Error("simulation cannot start during a configuration change");
    return simulation.start(request);
  });
  desktop_ipc.handle("cancel-simulation", () => shutdown_native());
  desktop_ipc.handle("select-gsr-result", async () => {
    admission.admit("analysis");
    const result = await dialog.showOpenDialog(require_main_window(), {
      defaultPath: results_dir,
      properties: ["openFile"],
      filters: [{ name: "GachaSimulate 结果", extensions: ["gsr"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    admission.admit("analysis");
    return result_editor.open(result.filePaths[0]);
  });
  desktop_ipc.handle("save-result-fields", (request) => {
    admission.admit("result-save");
    return result_editor.save(request);
  });
  desktop_ipc.handle("prepare-export", (request) => {
    return export_tasks.prepare(request);
  });
  desktop_ipc.handle("select-export-destination", (request) => {
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
  desktop_ipc.handle("confirm-export-overwrite", (request) => {
    return export_tasks.confirm_overwrite(request);
  });
  desktop_ipc.handle("cancel-export", (request) => {
    return export_tasks.cancel(request);
  });
  desktop_ipc.handle("retry-export-cleanup", (request) => {
    return export_tasks.retry_cleanup(request);
  });
  desktop_ipc.handle("open-export-directory", (request) => {
    return export_tasks.open_directory(request, open_directory);
  });
  desktop_ipc.handle("exit-after-export-cleanup", async (request) => {
    await request_exit(() => export_tasks.retry_cleanup(request));
  });
  desktop_ipc.handle("open-results-directory", () =>
    open_directory(results_dir),
  );
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
  if (exit_committed) return;
  event.preventDefault();
  void request_exit().catch(() => undefined);
});
