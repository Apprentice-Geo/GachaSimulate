import { useCurrentFrame, useVideoConfig } from "remotion";
import {
  ANIMATION_COMPLETION_FRAME,
  ANIMATION_TOTAL_MS,
} from "../animation/timeline";
import { build_animation_progress } from "../animation/progress";
import { VisualizeScene } from "../VisualizeScene";
import type { CDFViewModel } from "../types/cdf";

interface CdfCompositionProps {
  data?: CDFViewModel;
}

export function resolve_cdf_frame_state(frame: number, fps: number) {
  const is_animating = frame < ANIMATION_COMPLETION_FRAME;
  return {
    animation_state: is_animating ? ("playing" as const) : ("idle" as const),
    elapsed_ms: is_animating ? (frame / fps) * 1000 : ANIMATION_TOTAL_MS,
    is_animating,
  };
}

export function CdfComposition({ data }: CdfCompositionProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const frame_state = resolve_cdf_frame_state(frame, fps);
  const { elapsed_ms } = frame_state;
  const animation_progress = build_animation_progress(elapsed_ms);

  if (!data) {
    return null;
  }

  return (
    <VisualizeScene
      animation_progress={animation_progress}
      animation_state={frame_state.animation_state}
      data={data}
      is_animating={frame_state.is_animating}
      show_controls={false}
      use_fixed_chart_size
    />
  );
}
