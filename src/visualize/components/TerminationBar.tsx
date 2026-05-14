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
      <div className="termination-copy">
        <div className="section-kicker">TERMINATION</div>
        <h2>{data ? data.target : '模拟目标'}</h2>
        <p>
          {data
            ? '终止原因比例根据模拟器输出直接呈现。'
            : '导入数据后显示终止原因和比例。'}
        </p>
      </div>

      <div className="termination-bars" data-testid="termination-bar">
        {data ? (
          <>
            <div
              className="pk-bar"
              data-segment-count={data.termination_reason.length}
              aria-label="终止原因比例"
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
                      width: `${item.proportion}%`,
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
            {data.note && <p className="chart-note">{data.note}</p>}
          </>
        ) : (
          <div className="pk-bar pk-bar-empty" aria-hidden="true" />
        )}
      </div>
    </footer>
  );
}
