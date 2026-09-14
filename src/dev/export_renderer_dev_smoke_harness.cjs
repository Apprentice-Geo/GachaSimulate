/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

globalThis.exportRendererSmoke = { loadFailures: [], messages: [] };
app.commandLine.appendSwitch("force-device-scale-factor", "1");

ipcMain.on("export-renderer:initialized", (event, message) => {
  globalThis.exportRendererSmoke.messages.push({
    channel: "initialized",
    message,
  });
  event.sender.send("export-renderer:render-frame", {
    job_id: message.job_id,
    frame: 0,
  });
});
ipcMain.on("export-renderer:frame-ready", (_event, message) => {
  globalThis.exportRendererSmoke.messages.push({
    channel: "frame-ready",
    message,
  });
});
ipcMain.on("export-renderer:renderer-failed", (_event, message) => {
  globalThis.exportRendererSmoke.messages.push({
    channel: "renderer-failed",
    message,
  });
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    height: 2160,
    show: false,
    width: 3840,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "export_renderer_dev_smoke_preload.cjs"),
      sandbox: true,
    },
  });
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        globalThis.exportRendererSmoke.loadFailures.push({
          errorCode,
          errorDescription,
          validatedURL,
        });
      }
    },
  );
  window.setContentSize(3840, 2160, false);
  window.webContents.setZoomFactor(1);
  await window.loadURL(process.argv[2]);
});

app.on("window-all-closed", () => app.quit());
