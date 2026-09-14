/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { contextBridge, ipcRenderer } = require("electron");

function inbound(channel) {
  let listener = null;
  let pending = null;
  ipcRenderer.on(channel, (_event, message) => {
    if (listener) listener(message);
    else pending = message;
  });
  return (nextListener) => {
    listener = nextListener;
    if (pending) {
      const message = pending;
      pending = null;
      listener(message);
    }
    return () => {
      if (listener === nextListener) listener = null;
    };
  };
}

contextBridge.exposeInMainWorld("exportRendererApi", {
  onInitialize: inbound("export-renderer:initialize"),
  onRenderFrame: inbound("export-renderer:render-frame"),
  initialized: (message) =>
    ipcRenderer.send("export-renderer:initialized", message),
  frameReady: (message) =>
    ipcRenderer.send("export-renderer:frame-ready", message),
  rendererFailed: (message) =>
    ipcRenderer.send("export-renderer:renderer-failed", message),
});
