import type { CSSProperties } from "react";
import { fade_style, metric_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type { CDFViewModel, StatisticMetric } from "../types/cdf";
import {
  get_distribution_statistic_groups,
  get_statistic_description,
} from "../view/statistic_view_config";
import type { DistributionStatisticKey } from "../view/statistic_view_config";
import { ResultValue } from "./ResultValue";

interface StatisticPanelProps {
  data: CDFViewModel | null;
  animation_progress: AnimationProgress | null;
  is_ready: boolean;
}

function MetricRow({
  metric,
  unit,
  index,
  description,
  animation_progress,
}: {
  metric: StatisticMetric;
  unit: string;
  index: number;
  description: string;
  animation_progress: AnimationProgress | null;
}) {
  return (
    <div
      className="metric-row"
      data-emphasis={
        metric.key === "P50" || metric.key === "P95" || metric.key === "MEAN"
          ? "primary"
          : "secondary"
      }
      data-testid={`stat-${metric.key}`}
      data-stat-key={metric.key}
      key={metric.key}
      style={
        {
          "--metric-color": metric.color,
          "--metric-number-length": metric.display_value.length,
          "--stat-content-index": index,
          ...(animation_progress
            ? metric_style(animation_progress.stat_content(index))
            : {}),
        } as CSSProperties
      }
    >
      <div className="metric-copy">
        <div className="metric-label">{metric.label}</div>
        <div className="metric-description">{description}</div>
      </div>
      <div className="metric-value">
        <ResultValue value={metric.display_value} unit={unit} />
      </div>
    </div>
  );
}

export function StatisticPanel({
  data,
  animation_progress,
  is_ready,
}: StatisticPanelProps) {
  const metrics_by_key = new Map(
    data?.metrics.map((metric) => [metric.key, metric]),
  );
  const metric_groups = get_distribution_statistic_groups();
  const visible_metric_groups = metric_groups
    .map((group) => ({
      ...group,
      keys: group.keys.filter((key) => metrics_by_key.has(key)),
    }))
    .filter((group) => group.keys.length > 0);
  let stat_content_index = 0;
  const stat_group_index_by_title = new Map<string, number>();
  const display_index_by_key = new Map<DistributionStatisticKey, number>();
  visible_metric_groups.forEach((group) => {
    stat_group_index_by_title.set(group.title, stat_content_index);
    stat_content_index += 1;
    group.keys.forEach((key) => {
      display_index_by_key.set(key, stat_content_index);
      stat_content_index += 1;
    });
  });

  return (
    <aside
      className="statistic-panel"
      data-testid="statistic-panel"
      data-ready={is_ready}
    >
      <div
        aria-hidden="true"
        className="statistic-panel-surface panel-surface"
        style={
          animation_progress
            ? fade_style(animation_progress.stat_surface)
            : undefined
        }
      />
      {data ? (
        <div className="metric-list">
          {visible_metric_groups.map((group) => (
            <section
              className="metric-group"
              key={group.title}
              style={{ "--section-accent": group.accent } as CSSProperties}
            >
              <div
                className="metric-group-heading"
                style={
                  {
                    "--stat-content-index":
                      stat_group_index_by_title.get(group.title) ?? 0,
                    ...(animation_progress
                      ? metric_style(
                          animation_progress.stat_content(
                            stat_group_index_by_title.get(group.title) ?? 0,
                          ),
                        )
                      : {}),
                  } as CSSProperties
                }
              >
                <h2 className="visualize-section-label">{group.title}</h2>
              </div>
              {group.keys.map((key) => {
                const metric = metrics_by_key.get(key);
                if (!metric) {
                  return null;
                }
                return (
                  <MetricRow
                    animation_progress={animation_progress}
                    description={get_statistic_description(key)}
                    index={display_index_by_key.get(key) ?? 0}
                    key={metric.key}
                    metric={metric}
                    unit={data.result_item_unit}
                  />
                );
              })}
            </section>
          ))}
        </div>
      ) : (
        <div className="metric-placeholder" aria-hidden="true">
          {metric_groups.map((group) => (
            <div className="metric-placeholder-group" key={group.title}>
              <div className="placeholder-heading" />
              {group.keys.map((key) => (
                <div className="placeholder-line" key={key} />
              ))}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
