import type { CSSProperties } from "react";
import { fade_style, metric_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type { CDFViewModel } from "../types/cdf";
import { build_statistic_groups } from "../view/statistic_view_config";
import { ResultValue } from "./ResultValue";

interface StatisticPanelProps {
  data: CDFViewModel;
  animation_progress: AnimationProgress;
}

export function StatisticPanel({
  data,
  animation_progress,
}: StatisticPanelProps) {
  const groups = build_statistic_groups(data.metrics);
  return (
    <aside className="statistic-panel" data-testid="statistic-panel">
      <div
        aria-hidden="true"
        className="statistic-panel-surface panel-surface"
        style={fade_style(animation_progress.stat_surface)}
      />
      <div className="metric-list">
        {groups.map((group) => (
          <section
            className="metric-group"
            data-emphasis={group.emphasis}
            key={group.id}
            style={
              {
                "--section-accent": group.accent,
                "--metric-row-count": group.metrics.length,
              } as CSSProperties
            }
          >
            <div
              className="metric-group-heading"
              style={metric_style(
                animation_progress.stat_content(group.animation_index),
              )}
            >
              <h2 className="visualize-section-label">{group.title}</h2>
            </div>
            {group.metrics.map((metric) => (
              <div
                className="metric-row"
                data-emphasis={group.emphasis}
                data-testid={`stat-${metric.key}`}
                data-stat-key={metric.key}
                key={metric.key}
                style={
                  {
                    "--metric-color": metric.color,
                    "--metric-number-length": metric.display_value.length,
                    "--metric-value-font-size": `var(--visualize-font-${metric.value_size})`,
                    ...metric_style(
                      animation_progress.stat_content(metric.animation_index),
                    ),
                  } as CSSProperties
                }
              >
                <div className="metric-copy">
                  <div className="metric-label">{metric.label}</div>
                  <div className="metric-description">{metric.description}</div>
                </div>
                <div className="metric-value">
                  <ResultValue
                    value={metric.display_value}
                    unit={data.result_item_unit}
                  />
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}
