import { metric_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type { NormalizedVisualizeData } from "../types/visualize_input";

interface TopBarProps {
  data: NormalizedVisualizeData | null;
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
        ...(data.price ? [data.price] : []),
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
          {data && (
            <p className="outline" style={title_style(2)}>
              P50 为 {format_statistic(data.statistic.P50, data.display_unit)}，
              P95 为 {format_statistic(data.statistic.P95, data.display_unit)}。
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
