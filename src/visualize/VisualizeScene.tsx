import type { CSSProperties } from "react";
import { fade_style } from "./animation/progress";
import type { AnimationProgress } from "./animation/progress";
import { CDFChart } from "./components/CDFChart";
import { StatisticPanel } from "./components/StatisticPanel";
import { TerminationBar } from "./components/TerminationBar";
import { TopBar } from "./components/TopBar";
import type { NormalizedVisualizeData } from "./types/visualize_input";

const EXPORT_CHART_SIZE = {
  width: 2816,
  height: 1400,
} as const;

interface VisualizeSceneProps {
  data: NormalizedVisualizeData;
  animation_progress: AnimationProgress;
  animation_state: "playing" | "primed" | "idle";
  is_animating: boolean;
  on_file_import?: (file: File) => void;
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
  on_file_import,
  on_replay,
  show_controls = true,
  use_fixed_chart_size = false,
  style,
}: VisualizeSceneProps) {
  return (
    <main
      className="visualize-page"
      data-testid="visualize-root"
      data-load-state="ready"
      data-animation-state={animation_state}
      style={style}
    >
      <TopBar
        data={data}
        is_animating={is_animating}
        on_file_import={on_file_import}
        on_replay={on_replay}
        show_controls={show_controls}
        style={fade_style(animation_progress.top_bar)}
      />

      <section className="main-region" aria-label="CDF 可视化主体">
        <div className="primary-region">
          <div className="chart-region">
            <CDFChart
              animation_progress={animation_progress}
              data={data}
              fixed_size={use_fixed_chart_size ? EXPORT_CHART_SIZE : undefined}
              style={fade_style(animation_progress.chart_shell)}
            />
          </div>
          <TerminationBar
            animation_progress={animation_progress}
            data={data}
            is_ready
          />
        </div>
        <StatisticPanel
          animation_progress={animation_progress}
          data={data}
          is_ready
        />
      </section>

      {data.note && (
        <p className="page-note" style={fade_style(animation_progress.note)}>
          {data.note}
        </p>
      )}
    </main>
  );
}
