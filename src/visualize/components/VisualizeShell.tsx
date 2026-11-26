import type { CSSProperties, ReactNode } from "react";
import { fade_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type { CDFViewModel } from "../types/cdf";
import { StatisticPanel } from "./StatisticPanel";
import { TerminationBar } from "./TerminationBar";
import { TopBar, type RenderDisplayField } from "./TopBar";
import { SCENE_LAYOUT_STYLE } from "../view/scene_layout";

interface VisualizeShellProps {
  data: CDFViewModel;
  animation_progress: AnimationProgress;
  animation_state: "playing" | "primed" | "idle";
  edit?: RenderDisplayField;
  chart_slot: ReactNode;
  render_mode: "interactive" | "export";
  style?: CSSProperties;
}

export function VisualizeShell({
  data,
  animation_progress,
  animation_state,
  chart_slot,
  edit,
  render_mode,
  style,
}: VisualizeShellProps) {
  return (
    <main
      className="visualize-page"
      data-testid="visualize-root"
      data-load-state="ready"
      data-render-mode={render_mode}
      data-animation-state={animation_state}
      style={{ ...SCENE_LAYOUT_STYLE, ...style }}
    >
      <TopBar edit={edit} data={data} animation_progress={animation_progress} />

      <section className="main-region" aria-label="CDF 可视化主体">
        <div className="primary-region">
          <div className="chart-region">{chart_slot}</div>
          <TerminationBar animation_progress={animation_progress} data={data} />
        </div>
        <StatisticPanel
          animation_progress={animation_progress}
          data={data}
          unit_editor={edit?.("result_item_unit")}
        />
      </section>

      {(edit || data.note) && (
        <p className="page-note" style={fade_style(animation_progress.note)}>
          {edit?.("note") ?? <span className="scene-text">{data.note}</span>}
        </p>
      )}
    </main>
  );
}
