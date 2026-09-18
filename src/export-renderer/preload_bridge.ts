import {
  EXPORT_RENDERER_CHANNELS,
  is_export_failed_message,
  is_export_frame_message,
  is_export_initialize_message,
  is_export_initialized_message,
  type ExportRendererApi,
} from "../shared/export_renderer";

interface IpcRendererLike {
  on(
    channel: string,
    listener: (event: unknown, value: unknown) => void,
  ): unknown;
  send(channel: string, value: unknown): void;
}

type MessageGuard<T> = (value: unknown) => value is T;

function invalid_message(channel: string): TypeError {
  return new TypeError(`Invalid export renderer message for ${channel}`);
}

export function create_export_renderer_api(
  ipc_renderer: IpcRendererLike,
): ExportRendererApi {
  const create_inbound_channel = <T>(
    channel: string,
    guard: MessageGuard<T>,
  ) => {
    let listener: ((message: T) => void) | null = null;
    let pending: T | null = null;
    const handler = (_event: unknown, value: unknown) => {
      if (!guard(value)) return;
      if (listener) listener(value);
      else pending = value;
    };
    ipc_renderer.on(channel, handler);
    return (next_listener: (message: T) => void) => {
      listener = next_listener;
      if (pending) {
        const message = pending;
        pending = null;
        listener(message);
      }
      return () => {
        if (listener === next_listener) listener = null;
      };
    };
  };

  const on_initialize = create_inbound_channel(
    EXPORT_RENDERER_CHANNELS.initialize,
    is_export_initialize_message,
  );
  const on_render_frame = create_inbound_channel(
    EXPORT_RENDERER_CHANNELS.render_frame,
    is_export_frame_message,
  );

  const send = <T>(channel: string, guard: MessageGuard<T>, message: T) => {
    if (!guard(message)) throw invalid_message(channel);
    ipc_renderer.send(channel, message);
  };

  return {
    onInitialize: on_initialize,
    onRenderFrame: on_render_frame,
    initialized: (message) =>
      send(
        EXPORT_RENDERER_CHANNELS.initialized,
        is_export_initialized_message,
        message,
      ),
    frameReady: (message) =>
      send(
        EXPORT_RENDERER_CHANNELS.frame_ready,
        is_export_frame_message,
        message,
      ),
    rendererFailed: (message) =>
      send(
        EXPORT_RENDERER_CHANNELS.renderer_failed,
        is_export_failed_message,
        message,
      ),
  };
}
