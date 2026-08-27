import { contextBridge, ipcRenderer } from "electron";
import { create_export_renderer_api } from "../export-renderer/preload_bridge";

contextBridge.exposeInMainWorld(
  "exportRendererApi",
  create_export_renderer_api(ipcRenderer),
);
