import { metric_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type { CDFViewModel } from "../types/cdf";
import { ResultValue } from "./ResultValue";

interface TopBarProps {
  data: CDFViewModel;
  animation_progress: AnimationProgress;
}

function format_statistic(value: number, unit: string): string {
  const formatted = new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
  }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

export function TopBar({ data, animation_progress }: TopBarProps) {
  const metadata_items = [
    { key: "target", content: `模拟目标：${data.target}` },
    {
      key: "runs",
      content: (
        <>
          累计模拟次数：
          <span className="metadata-number">
            {format_statistic(data.runs, "")}
          </span>{" "}
          次
        </>
      ),
    },
    {
      key: "result",
      content: (
        <>
          累计{data.result_item.name}：
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
      <div className="top-bar-inner">
        <div className="title-stack">
          <div className="section-kicker" style={title_style(0)}>
            GACHASIMULATE CDF ANALYSIS
          </div>
          <h1 style={title_style(1)}>{data.title}</h1>
          {data.subtitle && (
            <p className="outline" style={title_style(2)}>
              {data.subtitle}
            </p>
          )}
        </div>
        <div className="top-meta" aria-label="模拟元信息">
          {metadata_items.map((item, index) => (
            <div key={item.key} style={metadata_style(index)}>
              {item.content}
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}
