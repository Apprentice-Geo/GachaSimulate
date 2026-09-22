import { Download, FolderOpen } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { fade_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type { CDFViewModel } from "../types/cdf";
import { ReplayButton } from "./ReplayButton";
import { StatisticPanel } from "./StatisticPanel";
import { TerminationBar } from "./TerminationBar";
import { TopBar } from "./TopBar";
import { SCENE_LAYOUT_STYLE } from "../view/scene_layout";

interface VisualizeShellProps {
  data: CDFViewModel;
  animation_progress: AnimationProgress;
  animation_state: "playing" | "primed" | "idle";
  chart_slot: ReactNode;
  is_animating: boolean;
  on_select_file?: () => void;
  on_replay?: () => void;
  on_export?: () => void;
  export_disabled_reason?: string;
  show_controls?: boolean;
  style?: CSSProperties;
}

export function VisualizeShell({
  data,
  animation_progress,
  animation_state,
  chart_slot,
  is_animating,
  on_select_file,
  on_replay,
  on_export,
  export_disabled_reason,
  show_controls = true,
  style,
}: VisualizeShellProps) {
  return (
    <main
      className="visualize-page"
      data-testid="visualize-root"
      data-load-state="ready"
      data-animation-state={animation_state}
      style={{ ...SCENE_LAYOUT_STYLE, ...style }}
    >
      <TopBar data={data} animation_progress={animation_progress} />

      <section className="main-region" aria-label="CDF 可视化主体">
        <div className="primary-region">
          <div className="chart-region">
            {chart_slot}
            {show_controls && on_replay && on_select_file && (
              <div className="chart-actions" aria-label="数据操作">
                <ReplayButton
                  disabled={false}
                  is_animating={is_animating}
                  on_replay={on_replay}
                />
                {on_export && (
                  <button
                    aria-label={
                      export_disabled_reason
                        ? `导出素材：${export_disabled_reason}`
                        : undefined
                    }
                    aria-disabled={Boolean(export_disabled_reason)}
                    className="command-button"
                    type="button"
                    onClick={() => {
                      if (!export_disabled_reason) on_export();
                    }}
                  >
                    <Download aria-hidden="true" size={18} />
                    <span>导出素材</span>
                  </button>
                )}
                <button
                  className="command-button"
                  type="button"
                  onClick={on_select_file}
                >
                  <FolderOpen aria-hidden="true" size={18} />
                  <span>选择结果</span>
                </button>
              </div>
            )}
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
