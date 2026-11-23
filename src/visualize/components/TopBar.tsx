import { metric_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type { CDFViewModel } from "../types/cdf";
import { ResultValue } from "./ResultValue";

interface TopBarProps {
  data: CDFViewModel;
  animation_progress: AnimationProgress;
}

export function TopBar({ data, animation_progress }: TopBarProps) {
  const metadata_items = [
    { key: "target", label: "模拟目标", content: data.target },
    {
      key: "runs",
      label: "累计模拟次数",
      content: (
        <span className="metadata-value">
          <ResultValue value={`${data.runs} 次`} unit="次" />
        </span>
      ),
    },
    {
      key: "result",
      label: `累计${data.result_item.name}`,
      content: (
        <>
          <span className="metadata-value">
            <ResultValue
              value={data.total_result_display}
              unit={data.result_item_unit}
            />
          </span>
        </>
      ),
    },
  ];
  const title_style = (index: number) =>
    metric_style(animation_progress.title_area(index));

  const metadata_style = (index: number) =>
    metric_style(animation_progress.metadata(index));
  return (
    <header className="top-bar">
      <svg
        className="result-card-fan"
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 120 100"
        style={{ opacity: animation_progress.title_area(0).opacity }}
      >
        {(["blue", "purple", "gold"] as const).map((color, index) => (
          <g
            key={color}
            transform={`rotate(${(index - 1) * 21} 60 84)`}
            stroke={`var(--color-rarity-${color})`}
          >
            <rect x="36" y="15" width="48" height="69" rx="5" />
            <rect
              x="40"
              y="19"
              width="40"
              height="61"
              rx="3"
              strokeWidth="1.3"
            />
            {color === "gold" && (
              <path
                d="M60 37 Q62 47 71 49 Q62 51 60 61 Q58 51 49 49 Q58 47 60 37Z"
                fill="var(--color-rarity-gold)"
                stroke="none"
              />
            )}
          </g>
        ))}
      </svg>
      <div className="top-bar-inner">
        <div className="title-stack">
          <h1 style={title_style(0)}>{data.title}</h1>
          {data.subtitle && (
            <p className="outline" style={title_style(1)}>
              {data.subtitle}
            </p>
          )}
        </div>
        <dl className="top-meta" aria-label="模拟元信息">
          {metadata_items.map((item, index) => (
            <div key={item.key} style={metadata_style(index)}>
              <dt>{item.label}：</dt>
              <dd>{item.content}</dd>
            </div>
          ))}
        </dl>
      </div>
    </header>
  );
}
