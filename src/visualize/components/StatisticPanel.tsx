import type { CSSProperties } from 'react';
import type {
  NormalizedVisualizeData,
  StatisticMetric,
} from '../types/visualize_input';

interface StatisticPanelProps {
  data: NormalizedVisualizeData | null;
  animation_key: number;
  is_ready: boolean;
}

type DistributionStatisticKey =
  | 'MIN'
  | 'P5'
  | 'P25'
  | 'P50'
  | 'MEAN'
  | 'P75'
  | 'P95'
  | 'MAX';

const METRIC_GROUPS = [
  {
    title: '低抽数区间',
    keys: ['MIN', 'P5', 'P25'],
  },
  {
    title: '中抽数区间',
    keys: ['P50', 'MEAN'],
  },
  {
    title: '高抽数区间',
    keys: ['P75', 'P95', 'MAX'],
  },
] as const satisfies readonly {
  title: string;
  keys: readonly DistributionStatisticKey[];
}[];

const METRIC_DESCRIPTIONS: Record<DistributionStatisticKey, string> = {
  MIN: '本次模拟达成抽数最小值',
  P5: '5% 模拟在此抽数内达成',
  P25: '25% 模拟在此抽数内达成',
  P50: '50% 模拟在此抽数内达成',
  MEAN: '所有模拟结果的平均抽数',
  P75: '75% 模拟在此抽数内达成',
  P95: '95% 模拟在此抽数内达成',
  MAX: '本次模拟达成抽数最大值',
};

function order_metric_keys(
  keys: readonly DistributionStatisticKey[],
  metrics_by_key: Map<string, StatisticMetric>,
): DistributionStatisticKey[] {
  if (!keys.includes('P50') || !keys.includes('MEAN')) {
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

    if (left === 'P50' && right === 'MEAN') {
      return -1;
    }
    if (left === 'MEAN' && right === 'P50') {
      return 1;
    }
    return 0;
  });
}

function MetricRow({
  metric,
  index,
  description,
}: {
  metric: StatisticMetric;
  index: number;
  description: string;
}) {
  return (
    <div
      className="metric-row"
      data-testid={`stat-${metric.key}`}
      key={metric.key}
      style={
        {
          '--metric-color': metric.color,
          '--stat-content-index': index,
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
  animation_key,
  is_ready,
}: StatisticPanelProps) {
  const metrics_by_key = new Map(
    data?.metrics.map((metric) => [metric.key, metric]),
  );
  const visible_metric_groups = METRIC_GROUPS.map((group) => ({
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
      key={`stat-panel-${animation_key}`}
    >

      {data ? (
        <div className="metric-list">
          {visible_metric_groups.map((group) => (
            <section className="metric-group" key={group.title}>
              <div
                className="metric-group-heading"
                style={
                  {
                    '--stat-content-index':
                      stat_group_index_by_title.get(group.title) ?? 0,
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
                    description={METRIC_DESCRIPTIONS[key]}
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
          {Array.from({ length: 8 }).map((_, index) => (
            <div className="placeholder-line" key={index} />
          ))}
        </div>
      )}
    </aside>
  );
}
