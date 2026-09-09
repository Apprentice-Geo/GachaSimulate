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
  render_mode: "interactive" | "export";
  on_select_file?: () => void;
  on_replay?: () => void;
  on_export?: () => void;
  export_disabled_reason?: string;
  style?: CSSProperties;
}

export function VisualizeScene({
  data,
  animation_progress,
  animation_state,
  is_animating,
  render_mode,
  on_select_file,
  on_replay,
  on_export,
  export_disabled_reason,
  style,
}: VisualizeSceneProps) {
  const is_export = render_mode === "export";

  return (
    <VisualizeShell
      animation_progress={animation_progress}
      animation_state={animation_state}
      chart_slot={
        <CDFChart
          animation_progress={animation_progress}
          data={data}
          fixed_size={is_export ? EXPORT_CHART_SIZE : undefined}
          style={fade_style(animation_progress.chart_shell)}
        />
      }
      data={data}
      is_animating={is_animating}
      load_state="ready"
      on_select_file={on_select_file}
      on_replay={on_replay}
      on_export={on_export}
      export_disabled_reason={export_disabled_reason}
      show_controls={!is_export}
      style={style}
    />
  );
}
