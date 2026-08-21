import type { CSSProperties } from "react";
import { fade_style } from "./animation/progress";
import type { AnimationProgress } from "./animation/progress";
import { CDFChart } from "./components/CDFChart";
import { VisualizeShell } from "./components/VisualizeShell";
import type { CDFViewModel } from "./types/cdf";

const EXPORT_CHART_SIZE = {
  width: 2816,
  height: 1400,
} as const;

interface VisualizeSceneProps {
  data: CDFViewModel;
  animation_progress: AnimationProgress;
  animation_state: "playing" | "primed" | "idle";
  is_animating: boolean;
  on_select_file?: () => void;
  on_replay?: () => void;
  show_controls?: boolean;
  use_fixed_chart_size?: boolean;
  style?: CSSProperties;
}

export function VisualizeScene({
  data,
  animation_progress,
  animation_state,
  is_animating,
  on_select_file,
  on_replay,
  show_controls = true,
  use_fixed_chart_size = false,
  style,
}: VisualizeSceneProps) {
  return (
    <VisualizeShell
      animation_progress={animation_progress}
      animation_state={animation_state}
      chart_slot={
        <CDFChart
          animation_progress={animation_progress}
          data={data}
          fixed_size={use_fixed_chart_size ? EXPORT_CHART_SIZE : undefined}
          style={fade_style(animation_progress.chart_shell)}
        />
      }
      data={data}
      is_animating={is_animating}
      load_state="ready"
      on_select_file={on_select_file}
      on_replay={on_replay}
      show_controls={show_controls}
      style={style}
    />
  );
}
