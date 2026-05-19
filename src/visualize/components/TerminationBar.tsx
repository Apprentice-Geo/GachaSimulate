import type { CSSProperties } from 'react';
import type { NormalizedVisualizeData } from '../types/visualize_input';

interface TerminationBarProps {
  data: NormalizedVisualizeData | null;
  animation_key: number;
  is_ready: boolean;
}

function get_segment_color(index: number): string {
  return index === 0 ? '#6a5fc1' : '#fa7faa';
}

export function TerminationBar({
  data,
  animation_key,
  is_ready,
}: TerminationBarProps) {
  return (
    <footer
      className="termination-region"
      data-ready={is_ready}
      key={`termination-${animation_key}`}
    >

      <div className="termination-bars" data-testid="termination-bar">
        <div className="metric-group-heading termination-heading">
          <h2>达成情况分布</h2>
        </div>
        {data ? (
          <>
            <div
              className="pk-bar"
              data-segment-count={data.termination_reason.length}
              aria-label="终止原因比例"
              style={
                {
                  '--first-segment-width': `${data.termination_reason[0].proportion}%`,
                } as CSSProperties
              }
            >
              {data.termination_reason.map((item, index) => (
                <div
                  className={
                    data.termination_reason.length === 2 && index === 1
                      ? 'pk-segment pk-segment-diagonal'
                      : 'pk-segment'
                  }
                  key={item.reason}
                  style={
                    {
                      '--segment-color': get_segment_color(index),
                      width:
                        data.termination_reason.length === 2 && index === 1
                          ? undefined
                          : `${item.proportion}%`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
            <div className="reason-list">
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
