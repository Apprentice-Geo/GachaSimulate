import type { CSSProperties } from "react";
import { fade_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type {
  NormalizedVisualizeData,
  TerminationReasonInput,
} from "../types/visualize_input";
import { TERMINATION_REASON_VIEW_CONFIG } from "../view/statistic_view_config";

interface TerminationBarProps {
  data: NormalizedVisualizeData | null;
  animation_progress: AnimationProgress | null;
  is_ready: boolean;
}

function get_segment_color(index: number): string {
  const colors = TERMINATION_REASON_VIEW_CONFIG.segment_colors;
  return colors[index % colors.length];
}

function get_segment_position(
  index: number,
  segment_count: number,
): "single" | "start" | "middle" | "end" {
  if (segment_count === 1) {
    return "single";
  }
  if (index === 0) {
    return "start";
  }
  if (index === segment_count - 1) {
    return "end";
  }
  return "middle";
}

function build_segment_layout(reasons: readonly TerminationReasonInput[]) {
  let cumulative_proportion = 0;
  return reasons.map((item, index) => {
    const start = cumulative_proportion;
    cumulative_proportion += item.proportion;
    return {
      item,
      index,
      start,
      position: get_segment_position(index, reasons.length),
    };
  });
}

export function TerminationBar({
  data,
  animation_progress,
  is_ready,
}: TerminationBarProps) {
  const segment_layout = data
    ? build_segment_layout(data.termination_reason)
    : [];

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
                  opacity: animation_progress?.pk_fill ?? 1,
                } as CSSProperties
              }
            >
              <div
                className="pk-segments"
                style={{
                  transform: `scaleX(${animation_progress?.pk_fill ?? 1})`,
                }}
              >
                {segment_layout.map(({ item, index, position, start }) => {
                  const has_leading_seam =
                    position === "middle" || position === "end";
                  return (
                    <div
                      className={`pk-segment pk-segment-${position}`}
                      data-segment-position={position}
                      key={item.reason}
                      style={
                        {
                          "--segment-color": get_segment_color(index),
                          display: item.proportion === 0 ? "none" : undefined,
                          left: has_leading_seam
                            ? `calc(${start}% - var(--pk-seam-width))`
                            : `${start}%`,
                          width: has_leading_seam
                            ? `calc(${item.proportion}% + var(--pk-seam-width))`
                            : `${item.proportion}%`,
                          zIndex: index,
                        } as CSSProperties
                      }
                    />
                  );
                })}
              </div>
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
