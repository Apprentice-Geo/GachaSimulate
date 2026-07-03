import type { CSSProperties } from "react";
import { fade_style, metric_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type {
  NormalizedVisualizeData,
  StatisticMetric,
} from "../types/visualize_input";
import {
  DISTRIBUTION_STATISTIC_GROUPS,
  STATISTIC_VIEW_CONFIG,
} from "../view/statistic_view_config";
import type { DistributionStatisticKey } from "../view/statistic_view_config";

interface StatisticPanelProps {
  data: NormalizedVisualizeData | null;
  animation_progress: AnimationProgress | null;
  is_ready: boolean;
}

function order_metric_keys(
  keys: readonly DistributionStatisticKey[],
  metrics_by_key: Map<string, StatisticMetric>,
): DistributionStatisticKey[] {
  if (!keys.includes("P50") || !keys.includes("MEAN")) {
    return [...keys];
  }

  return [...keys].sort((left, right) => {
    const left_metric = metrics_by_key.get(left);
    const right_metric = metrics_by_key.get(right);
    if (!left_metric || !right_metric) {
      return 0;
    }

    const value_order = left_metric.value - right_metric.value;
    if (value_order !== 0) {
      return value_order;
    }

    if (left === "P50" && right === "MEAN") {
      return -1;
    }
    if (left === "MEAN" && right === "P50") {
      return 1;
    }
    return 0;
  });
}

function MetricRow({
  metric,
  index,
  description,
  animation_progress,
}: {
  metric: StatisticMetric;
  index: number;
  description: string;
  animation_progress: AnimationProgress | null;
}) {
  return (
    <div
      className="metric-row"
      data-testid={`stat-${metric.key}`}
      key={metric.key}
      style={
        {
          "--metric-color": metric.color,
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
        <span>{metric.display_value}</span>
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
  const visible_metric_groups = DISTRIBUTION_STATISTIC_GROUPS.map((group) => ({
    ...group,
    keys: order_metric_keys(group.keys, metrics_by_key).filter((key) =>
      metrics_by_key.has(key),
    ),
  })).filter((group) => group.keys.length > 0);
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
      style={
        animation_progress
          ? fade_style(animation_progress.stat_panel)
          : undefined
      }
    >
      {data ? (
        <div className="metric-list">
          {visible_metric_groups.map((group) => (
            <section className="metric-group" key={group.title}>
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
                <h2>{group.title}</h2>
              </div>
              {group.keys.map((key) => {
                const metric = metrics_by_key.get(key);
                if (!metric) {
                  return null;
                }
                return (
                  <MetricRow
                    animation_progress={animation_progress}
                    description={STATISTIC_VIEW_CONFIG[key].description}
                    index={display_index_by_key.get(key) ?? 0}
                    key={metric.key}
                    metric={metric}
                  />
                );
              })}
            </section>
          ))}
        </div>
      ) : (
        <div className="metric-placeholder" aria-hidden="true">
          {DISTRIBUTION_STATISTIC_GROUPS.map((group) => (
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
