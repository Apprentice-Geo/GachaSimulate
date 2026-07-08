import type { CSSProperties } from "react";
import { fade_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type { NormalizedVisualizeData } from "../types/visualize_input";
import { TERMINATION_REASON_VIEW_CONFIG } from "../view/statistic_view_config";

interface TerminationBarProps {
  data: NormalizedVisualizeData | null;
  animation_progress: AnimationProgress | null;
  is_ready: boolean;
}

function get_segment_color(index: number): string {
  return (
    TERMINATION_REASON_VIEW_CONFIG.segment_colors[index] ??
    TERMINATION_REASON_VIEW_CONFIG.segment_colors[0]
  );
}

export function TerminationBar({
  data,
  animation_progress,
  is_ready,
}: TerminationBarProps) {
  return (
    <footer
      className="termination-region"
      data-ready={is_ready}
      style={
        animation_progress
          ? fade_style(animation_progress.termination_panel)
          : undefined
      }
    >
      <div className="termination-bars" data-testid="termination-bar">
        <div className="metric-group-heading termination-heading">
          <h2>达成路径分布</h2>
        </div>
        {data ? (
          <>
            <div
              className="pk-bar"
              data-segment-count={data.termination_reason.length}
              aria-label="终止原因比例"
              style={
                {
                  "--first-segment-width": `${data.termination_reason[0].proportion}%`,
                  opacity: animation_progress?.pk_fill ?? 1,
                } as CSSProperties
              }
            >
              {data.termination_reason.map((item, index) => (
                <div
                  className={
                    data.termination_reason.length === 2 && index === 1
                      ? "pk-segment pk-segment-diagonal"
                      : "pk-segment"
                  }
                  key={item.reason}
                  style={
                    {
                      "--segment-color": get_segment_color(index),
                      transform: `scaleX(${animation_progress?.pk_fill ?? 1})`,
                      width:
                        data.termination_reason.length === 2 && index === 1
                          ? undefined
                          : `${item.proportion}%`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
            <div
              className="reason-list"
              style={
                animation_progress
                  ? fade_style(animation_progress.termination_detail)
                  : undefined
              }
            >
              {data.termination_reason.map((item, index) => (
                <div className="reason-item" key={item.reason}>
                  <span
                    className="reason-swatch"
                    style={{ background: get_segment_color(index) }}
                  />
                  <span>{item.reason}</span>
                  <strong>{item.proportion}%</strong>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="pk-bar pk-bar-empty" aria-hidden="true" />
        )}
      </div>
    </footer>
  );
}
