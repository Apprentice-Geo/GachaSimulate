import { useCurrentFrame, useVideoConfig } from "remotion";
import { ANIMATION_TOTAL_MS } from "../animation/timeline";
import { build_animation_progress } from "../animation/progress";
import { VisualizeScene } from "../VisualizeScene";
import type { NormalizedVisualizeData } from "../types/visualize_input";

interface CdfCompositionProps {
  data?: NormalizedVisualizeData;
}

export function CdfComposition({ data }: CdfCompositionProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsed_ms = Math.min(ANIMATION_TOTAL_MS, (frame / fps) * 1000);
  const animation_progress = build_animation_progress(elapsed_ms);

  if (!data) {
    return null;
  }

  return (
    <VisualizeScene
      animation_progress={animation_progress}
      animation_state={elapsed_ms < ANIMATION_TOTAL_MS ? "playing" : "idle"}
      data={data}
      is_animating={elapsed_ms < ANIMATION_TOTAL_MS}
      show_controls={false}
      use_fixed_chart_size
    />
  );
}
