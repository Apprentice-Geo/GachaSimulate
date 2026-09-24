import type { CSSProperties } from "react";
import { fade_style } from "./animation/progress";
import type { AnimationProgress } from "./animation/progress";
import { CDFChart } from "./components/CDFChart";
import { VisualizeShell } from "./components/VisualizeShell";
import type { CDFViewModel } from "./types/cdf";
import { CDF_CHART_SIZE } from "./view/scene_layout";

interface VisualizeSceneProps {
  data: CDFViewModel;
  animation_progress: AnimationProgress;
  animation_state: "playing" | "primed" | "idle";
  render_mode: "interactive" | "export";
  style?: CSSProperties;
}

export function VisualizeScene({
  data,
  animation_progress,
  animation_state,
  render_mode,
  style,
}: VisualizeSceneProps) {
  return (
    <VisualizeShell
      animation_progress={animation_progress}
      animation_state={animation_state}
      chart_slot={
        <CDFChart
          size={CDF_CHART_SIZE}
          animation_progress={animation_progress}
          data={data}
          style={fade_style(animation_progress.chart_shell)}
        />
      }
      data={data}
      render_mode={render_mode}
      style={style}
    />
  );
}
