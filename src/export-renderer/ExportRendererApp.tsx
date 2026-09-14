import { useLayoutEffect, useRef, useState } from "react";
import type { CDFViewModel } from "../visualize/types/cdf";
import { resolve_export_frame_state } from "../visualize/animation/export_frame";
import { build_animation_progress } from "../visualize/animation/progress";
import { VisualizeScene } from "../visualize/VisualizeScene";
import {
  ExportRendererCoordinator,
  type ExportFrameToken,
} from "./coordinator";
import { wait_for_export_layout } from "./layout";

declare const __GACHASIMULATE_EXPORT_FRAME_PROBE__: boolean;

const PROBE_BITS = 8;

interface Initialization {
  job_id: string;
  view_model: CDFViewModel;
}

export default function ExportRendererApp() {
  const coordinator = useRef(new ExportRendererCoordinator());
  const [initialization, set_initialization] = useState<Initialization | null>(
    null,
  );
  const [request, set_request] = useState<ExportFrameToken | null>(null);

  const report_failure = (value: unknown, reason: unknown) => {
    const failure = coordinator.current.fail(value, reason);
    send_failure(failure);
  };

  const send_failure = (
    failure: Parameters<typeof window.exportRendererApi.rendererFailed>[0],
  ) => {
    try {
      window.exportRendererApi.rendererFailed(failure);
    } catch {
      // The renderer cannot recover if its only outbound channel has failed.
    }
  };

  useLayoutEffect(() => {
    const remove_initialize = window.exportRendererApi.onInitialize(
      (message) => {
        const result = coordinator.current.acceptInitialize(message);
        if (!result.ok) {
          send_failure(result.failure);
          return;
        }
        set_initialization(result.message);
      },
    );
    const remove_render_frame = window.exportRendererApi.onRenderFrame(
      (message) => {
        const result = coordinator.current.acceptFrame(message);
        if (!result.ok) {
          send_failure(result.failure);
          return;
        }
        set_request(result.token);
      },
    );
    return () => {
      remove_initialize();
      remove_render_frame();
    };
  }, []);

  useLayoutEffect(() => {
    if (!initialization) return;
    let cancelled = false;
    void wait_for_export_layout(document).then(
      () => {
        if (
          !cancelled &&
          coordinator.current.completeInitialization(initialization.job_id)
        ) {
          try {
            window.exportRendererApi.initialized({
              job_id: initialization.job_id,
            });
          } catch (reason) {
            report_failure(initialization, reason);
          }
        }
      },
      (reason) => {
        if (!cancelled) report_failure(initialization, reason);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [initialization]);

  useLayoutEffect(() => {
    if (!request || !coordinator.current.completeFrame(request)) return;
    try {
      window.exportRendererApi.frameReady({
        job_id: request.job_id,
        frame: request.frame,
      });
    } catch (reason) {
      report_failure(request, reason);
    }
  }, [request]);

  if (!initialization) return null;

  const frame = request?.frame ?? 0;
  const frame_state = resolve_export_frame_state(frame);
  return (
    <>
      <VisualizeScene
        animation_progress={build_animation_progress(frame_state.elapsed_ms)}
        animation_state={frame_state.animation_state}
        data={initialization.view_model}
        is_animating={frame_state.is_animating}
        render_mode="export"
      />
      {__GACHASIMULATE_EXPORT_FRAME_PROBE__ && (
        <div
          aria-hidden="true"
          data-export-frame-probe="true"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(10, 8px)",
            height: 8,
            left: 0,
            position: "fixed",
            top: 0,
            width: 80,
            zIndex: 2_147_483_647,
          }}
        >
          <i
            data-probe="start"
            style={{ background: "#ff00ff", display: "block", height: 8 }}
          />
          {Array.from({ length: PROBE_BITS }, (_, bit) => (
            <i
              data-probe-bit={bit}
              data-value={(frame >> bit) & 1}
              key={bit}
              style={{
                background: (frame >> bit) & 1 ? "#ffffff" : "#000000",
                display: "block",
                height: 8,
              }}
            />
          ))}
          <i
            data-probe="end"
            style={{ background: "#00ffff", display: "block", height: 8 }}
          />
        </div>
      )}
    </>
  );
}
