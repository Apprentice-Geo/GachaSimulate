import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktopApi", {
  listInstalledConfigs: () => ipcRenderer.invoke("list-installed-configs"),
});
