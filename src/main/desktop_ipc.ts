import type {
  BrowserWindow,
  IpcMain,
  IpcMainInvokeEvent,
  WebContents,
} from "electron";
import { cpus } from "node:os";
import type {
  DesktopArgs,
  DesktopChannel,
  DesktopEventChannel,
  DesktopEvents,
  DesktopResponse,
} from "../shared/desktop_ipc";
import { app_links, type AppLink } from "../shared/app_info";
import { validate_simulation_request } from "../shared/simulation";
import {
  validate_export_cancel_request,
  validate_export_destination_request,
  validate_export_preparation_request,
  validate_export_task_request,
} from "../shared/export_task";
import { validate_save_result_fields_request } from "./result_editor";

type Validator<C extends DesktopChannel> = (
  ...args: unknown[]
) => DesktopArgs<C>;
export type DesktopHandler<C extends DesktopChannel> = (
  ...args: DesktopArgs<C>
) => DesktopResponse<C> | Promise<DesktopResponse<C>>;
type DesktopWindow = Pick<BrowserWindow, "isDestroyed"> & {
  webContents: Pick<WebContents, "isDestroyed" | "mainFrame" | "send">;
};

const no_args = (...args: unknown[]): [] => {
  if (args.length) throw new Error("desktop request takes no arguments");
  return [];
};
function one<T>(validate: (value: unknown) => T): (...args: unknown[]) => [T] {
  return (...args) => {
    if (args.length !== 1)
      throw new Error("desktop request takes one argument");
    return [validate(args[0])];
  };
}
function config_id(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid configuration id");
  return value;
}
function app_link(value: unknown): AppLink {
  if (typeof value !== "string" || !Object.hasOwn(app_links, value))
    throw new Error("unknown application link");
  return value as AppLink;
}

const validators: { [C in DesktopChannel]: Validator<C> } = {
  "open-app-link": one(app_link),
  "list-configs": no_args,
  "get-config-repository-state": no_args,
  "refresh-config-repository": (...args) => {
    const force = args[0];
    if (args.length > 1 || (force !== undefined && typeof force !== "boolean"))
      throw new Error("invalid refresh flag");
    return force === undefined ? [] : [force];
  },
  "install-config": one(config_id),
  "update-config": one(config_id),
  "uninstall-config": one(config_id),
  "select-local-config-directory": no_args,
  "get-logical-cpu-count": no_args,
  "start-simulation": one((value) => {
    validate_simulation_request(value, cpus().length);
    return value;
  }),
  "cancel-simulation": no_args,
  "select-gsr-result": no_args,
  "save-result-fields": one(validate_save_result_fields_request),
  "prepare-export": one(validate_export_preparation_request),
  "select-export-destination": one(validate_export_destination_request),
  "confirm-export-overwrite": one(validate_export_destination_request),
  "cancel-export": one(validate_export_cancel_request),
  "retry-export-cleanup": one(validate_export_task_request),
  "open-export-directory": one(validate_export_task_request),
  "exit-after-export-cleanup": one(validate_export_task_request),
  "open-results-directory": no_args,
};

export function is_desktop_url(value: string, expected: string): boolean {
  try {
    const actual = new URL(value);
    const trusted = new URL(expected);
    actual.hash = trusted.hash = "";
    return actual.href === trusted.href;
  } catch {
    return false;
  }
}

export function protect_desktop_navigation(
  window: BrowserWindow,
  expected_url: string,
): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (!is_desktop_url(url, expected_url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!is_desktop_url(url, expected_url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

export class DesktopIpc {
  constructor(
    private readonly ipc: Pick<IpcMain, "handle">,
    private readonly get_window: () => DesktopWindow | null,
    private readonly expected_url: string,
  ) {}

  private trusted_window(): DesktopWindow | null {
    const window = this.get_window();
    return window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      is_desktop_url(window.webContents.mainFrame.url, this.expected_url)
      ? window
      : null;
  }

  private assert_sender(event: IpcMainInvokeEvent): void {
    const window = this.trusted_window();
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("desktop request came from an untrusted renderer");
  }

  handle<C extends DesktopChannel>(
    channel: C,
    handler: DesktopHandler<C>,
  ): void {
    this.ipc.handle(channel, (event, ...args: unknown[]) => {
      this.assert_sender(event);
      const validated = validators[channel](...args);
      return handler(...validated);
    });
  }

  send<C extends DesktopEventChannel>(
    channel: C,
    value: DesktopEvents[C],
  ): void {
    const window = this.trusted_window();
    if (!window) return;
    try {
      window.webContents.send(channel, value);
    } catch (error) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        throw error;
    }
  }
}
