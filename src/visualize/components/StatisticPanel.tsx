import type { CSSProperties } from 'react';
import type { NormalizedVisualizeData } from '../types/visualize_input';

interface StatisticPanelProps {
  data: NormalizedVisualizeData | null;
  animation_key: number;
  is_ready: boolean;
}

export function StatisticPanel({
  data,
  animation_key,
  is_ready,
}: StatisticPanelProps) {
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
          {data.metrics.map((metric, index) => (
            <div
              className="metric-row"
              data-testid={`stat-${metric.key}`}
              key={metric.key}
              style={
                {
                  '--metric-color': metric.color,
                  '--metric-index': index,
                } as CSSProperties
              }
            >
              <div className="metric-label">{metric.label}</div>
              <div className="metric-value">
                <span>{metric.display_value}</span>
                <small>{metric.unit}</small>
              </div>
            </div>
          ))}
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
