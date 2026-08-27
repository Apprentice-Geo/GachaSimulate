import { useLayoutEffect, useMemo, useState } from "react";
import analysis_fixture from "../visualize/fixtures/example_analysis.json";
import display_fixture from "../visualize/fixtures/example_display.json";
import { build_animation_progress } from "../visualize/animation/progress";
import { ANIMATION_COMPLETION_FRAME } from "../visualize/animation/timeline";
import { VIDEO_FPS } from "../visualize/constants";
import { validate_analysis } from "../visualize/data/analysis";
import { validate_display_config } from "../visualize/data/validate_display_config";
import { build_cdf_view_model } from "../visualize/view/cdf_view_model";
import { VisualizeScene } from "../visualize/VisualizeScene";

export type ExportSpikeBarrier = "commit" | "fonts" | "raf" | "double-raf";

interface FrameRequest {
  id: number;
  frame: number;
  barrier: ExportSpikeBarrier;
  resolve: (value: ExportSpikeReady) => void;
  reject: (reason: unknown) => void;
}

export interface ExportSpikeReady {
  request_id: number;
  frame: number;
  barrier: ExportSpikeBarrier;
}

declare global {
  interface Window {
    electronExportSpike?: {
      setFrame: (
        frame: number,
        barrier: ExportSpikeBarrier,
      ) => Promise<ExportSpikeReady>;
    };
  }
}

const PROBE_BITS = 8;

function next_animation_frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function wait_for_barrier(barrier: ExportSpikeBarrier): Promise<void> {
  if (barrier === "commit") return;
  await document.fonts.ready;
  if (barrier === "fonts") return;
  await next_animation_frame();
  if (barrier === "raf") return;
  await next_animation_frame();
}

export default function ExportSpikeApp() {
  const [frame, set_frame] = useState(0);
  const [request, set_request] = useState<FrameRequest | null>(null);
  const data = useMemo(
    () =>
      build_cdf_view_model(
        validate_analysis(analysis_fixture),
        validate_display_config(display_fixture),
      ),
    [],
  );

  useLayoutEffect(() => {
    let next_id = 0;
    window.electronExportSpike = {
      setFrame(next_frame, barrier) {
        return new Promise((resolve, reject) => {
          const next_request = {
            id: ++next_id,
            frame: next_frame,
            barrier,
            resolve,
            reject,
          };
          set_frame(next_frame);
          set_request(next_request);
        });
      },
    };
    document.documentElement.dataset.exportSpikeReady = "true";
    return () => {
      delete window.electronExportSpike;
      delete document.documentElement.dataset.exportSpikeReady;
    };
  }, []);

  useLayoutEffect(() => {
    if (!request || request.frame !== frame) return;
    let cancelled = false;
    void wait_for_barrier(request.barrier).then(
      () => {
        if (!cancelled) {
          request.resolve({
            request_id: request.id,
            frame,
            barrier: request.barrier,
          });
        }
      },
      (error) => {
        if (!cancelled) request.reject(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [frame, request]);

  const elapsed_ms =
    (Math.min(frame, ANIMATION_COMPLETION_FRAME) / VIDEO_FPS) * 1000;
  const is_animating = frame < ANIMATION_COMPLETION_FRAME;

  return (
    <>
      <VisualizeScene
        animation_progress={build_animation_progress(elapsed_ms)}
        animation_state={is_animating ? "playing" : "idle"}
        data={data}
        is_animating={is_animating}
        show_controls={false}
        use_fixed_chart_size
      />
      <div className="export-spike-probe" data-testid="export-spike-probe">
        <i data-probe="start" />
        {Array.from({ length: PROBE_BITS }, (_, bit) => (
          <i data-probe-bit={bit} data-value={(frame >> bit) & 1} key={bit} />
        ))}
        <i data-probe="end" />
      </div>
    </>
  );
}
