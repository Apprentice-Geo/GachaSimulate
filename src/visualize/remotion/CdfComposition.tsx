import { useCurrentFrame } from "remotion";
import { resolve_export_frame_state } from "../animation/export_frame";
import { build_animation_progress } from "../animation/progress";
import { VisualizeScene } from "../VisualizeScene";
import type { CDFViewModel } from "../types/cdf";

interface CdfCompositionProps {
  data?: CDFViewModel;
}

export function CdfComposition({ data }: CdfCompositionProps) {
  const frame = useCurrentFrame();
  const frame_state = resolve_export_frame_state(frame);
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
      render_mode="export"
    />
  );
}
