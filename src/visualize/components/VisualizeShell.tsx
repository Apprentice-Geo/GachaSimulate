import type { CSSProperties, ReactNode } from "react";
import { fade_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type { NormalizedVisualizeData } from "../types/visualize_input";
import { StatisticPanel } from "./StatisticPanel";
import { TerminationBar } from "./TerminationBar";
import { TopBar } from "./TopBar";

interface VisualizeShellProps {
  data: NormalizedVisualizeData | null;
  animation_progress: AnimationProgress | null;
  animation_state: "playing" | "primed" | "idle";
  chart_slot: ReactNode;
  is_animating: boolean;
  load_state: "idle" | "loading" | "error" | "ready";
  on_file_import?: (file: File) => void;
  on_replay?: () => void;
  show_controls?: boolean;
  style?: CSSProperties;
}

export function VisualizeShell({
  data,
  animation_progress,
  animation_state,
  chart_slot,
  is_animating,
  load_state,
  on_file_import,
  on_replay,
  show_controls = true,
  style,
}: VisualizeShellProps) {
  const is_ready = load_state === "ready" && data !== null;

  return (
    <main
      className="visualize-page"
      data-testid="visualize-root"
      data-load-state={load_state}
      data-animation-state={animation_state}
      style={style}
    >
      <TopBar
        data={data}
        is_animating={is_animating}
        on_file_import={on_file_import}
        on_replay={on_replay}
        show_controls={show_controls}
        style={
          animation_progress
            ? fade_style(animation_progress.top_bar)
            : undefined
        }
      />

      <section className="main-region" aria-label="CDF 可视化主体">
        <div className="primary-region">
          <div className="chart-region">{chart_slot}</div>
          <TerminationBar
            animation_progress={animation_progress}
            data={data}
            is_ready={is_ready}
          />
        </div>
        <StatisticPanel
          animation_progress={animation_progress}
          data={data}
          is_ready={is_ready}
        />
      </section>

      {data?.note && (
        <p
          className="page-note"
          style={
            animation_progress ? fade_style(animation_progress.note) : undefined
          }
        >
          {data.note}
        </p>
      )}
    </main>
  );
}
