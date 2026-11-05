import { ipcRenderer } from "electron";
import type {
  DesktopArgs,
  DesktopChannel,
  DesktopEventChannel,
  DesktopEvents,
  DesktopResponse,
} from "../shared/desktop_ipc";

// Electron's Promise<any> boundary is confined to these bridge helpers.
export function invoke_desktop<C extends DesktopChannel>(
  channel: C,
  ...args: DesktopArgs<C>
): Promise<DesktopResponse<C>> {
  return ipcRenderer.invoke(channel, ...args);
}

export function subscribe_desktop<C extends DesktopEventChannel>(
  channel: C,
  listener: (event: DesktopEvents[C]) => void,
): () => void {
  const handler = (
    _event: Electron.IpcRendererEvent,
    value: DesktopEvents[C],
  ) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
