import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import {
  initialize_installed_configs,
  scan_installed_configs,
} from "./config_manager";

function create_window(): void {
  const window = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.js"),
    },
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
  ipcMain.handle("list-installed-configs", () =>
    scan_installed_configs(installed_dir),
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
