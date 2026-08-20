import { metric_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type { CDFViewModel } from "../types/cdf";

interface TopBarProps {
  data: CDFViewModel | null;
  animation_progress: AnimationProgress | null;
}

function format_statistic(value: number, unit: string): string {
  const formatted = new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
  }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

export function TopBar({ data, animation_progress }: TopBarProps) {
  const metadata_items = data
    ? [
        `模拟目标：${data.target}`,
        `累计模拟次数：${format_statistic(data.runs, "")} 次`,
        `累计${data.result_item.name}：${format_statistic(data.total, data.display_unit)}`,
      ]
    : ["导入模拟器输出 JSON 后生成结果页面"];
  const title_style = (index: number) =>
    animation_progress
      ? metric_style(animation_progress.title_area(index))
      : undefined;

  const metadata_style = (index: number) =>
    animation_progress
      ? metric_style(animation_progress.metadata(index))
      : undefined;
  return (
    <header className="top-bar">
      <div className="top-bar-inner">
        <div className="title-stack">
          <div className="section-kicker" style={title_style(0)}>
            GACHASIMULATE CDF ANALYSIS
          </div>
          <h1 style={title_style(1)}>{data?.title ?? "抽卡模拟 CDF 分析"}</h1>
          {data?.price && (
            <p className="outline" style={title_style(2)}>
              {data.price}
            </p>
          )}
        </div>
        <div className="top-meta" aria-label="模拟元信息">
          {metadata_items.map((item, index) => (
            <div key={item} style={metadata_style(index)}>
              {item}
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}
