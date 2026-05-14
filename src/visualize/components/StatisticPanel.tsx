import type { CSSProperties } from 'react';
import type {
  NormalizedVisualizeData,
  StatisticKey,
  StatisticMetric,
} from '../types/visualize_input';

interface StatisticPanelProps {
  data: NormalizedVisualizeData | null;
  animation_key: number;
  is_ready: boolean;
}

const METRIC_GROUPS = [
  {
    title: '较优结果',
    subtitle: '低抽数区间',
    keys: ['MIN', 'P5', 'P25'],
  },
  {
    title: '中心位置',
    subtitle: '典型结果',
    keys: ['P50', 'MEAN'],
  },
  {
    title: '尾部风险',
    subtitle: '高抽数区间',
    keys: ['P75', 'P95', 'MAX'],
  },
] as const satisfies readonly {
  title: string;
  subtitle: string;
  keys: readonly StatisticKey[];
}[];

const METRIC_DESCRIPTIONS: Record<StatisticKey, string> = {
  MIN: '最优样本',
  P5: '5% 分位',
  P25: '25% 分位',
  P50: '中位抽数',
  MEAN: '平均抽数',
  P75: '75% 分位',
  P95: '95% 分位',
  MAX: '最差尾部',
  COST: '单抽成本',
};

function MetricRow({
  metric,
  index,
  className = '',
}: {
  metric: StatisticMetric;
  index: number;
  className?: string;
}) {
  return (
    <div
      className={`metric-row${className ? ` ${className}` : ''}`}
      data-testid={`stat-${metric.key}`}
      key={metric.key}
      style={
        {
          '--metric-color': metric.color,
          '--metric-index': index,
        } as CSSProperties
      }
    >
      <div className="metric-copy">
        <div className="metric-label">{metric.label}</div>
        <div className="metric-description">
          {METRIC_DESCRIPTIONS[metric.key]}
        </div>
      </div>
      <div className="metric-value">
        <span>{metric.display_value}</span>
        <small>{metric.unit}</small>
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
  const cost_metric = metrics_by_key.get('COST');

  return (
    <aside
      className="statistic-panel"
      data-testid="statistic-panel"
      data-ready={is_ready}
      key={`stat-panel-${animation_key}`}
    >
      <div className="panel-heading">
        <span>核心统计量</span>
        <span>{data ? '9 metrics' : 'pending'}</span>
      </div>

      {data ? (
        <div className="metric-list">
          {METRIC_GROUPS.map((group) => (
            <section className="metric-group" key={group.title}>
              <div className="metric-group-heading">
                <h2>{group.title}</h2>
                <span>{group.subtitle}</span>
              </div>
              {group.keys.map((key) => {
                const metric = metrics_by_key.get(key);
                if (!metric) {
                  return null;
                }
                return (
                  <MetricRow
                    index={data.metrics.indexOf(metric)}
                    key={metric.key}
                    metric={metric}
                  />
                );
              })}
            </section>
          ))}
          {cost_metric ? (
            <MetricRow
              className="metric-cost-row"
              index={data.metrics.indexOf(cost_metric)}
              metric={cost_metric}
            />
          ) : null}
        </div>
      ) : (
        <div className="metric-placeholder" aria-hidden="true">
          {Array.from({ length: 9 }).map((_, index) => (
            <div className="placeholder-line" key={index} />
          ))}
        </div>
      )}
    </aside>
  );
}
