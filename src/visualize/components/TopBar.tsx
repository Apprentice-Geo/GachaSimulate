import { metric_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type { NormalizedVisualizeData } from "../types/visualize_input";

interface TopBarProps {
  data: NormalizedVisualizeData | null;
  animation_progress: AnimationProgress | null;
}

export function TopBar({ data, animation_progress }: TopBarProps) {
  const metadata_items = data
    ? [
        `模拟目标：${data.target}`,
        `本轮模拟抽数：${data.draw_counts_display}`,
        `单抽成本：${data.cost.display_value} ${data.cost.unit}`,
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
      <div className="title-stack">
        <div className="section-kicker" style={title_style(0)}>
          GACHASIMULATE CDF ANALYSIS
        </div>
        <h1 style={title_style(1)}>{data?.title ?? "抽卡模拟 CDF 分析"}</h1>
        {data && (
          <p style={title_style(2)}>
            半数模拟 {data.statistic.P50} 抽内达成，95% 模拟{" "}
            {data.statistic.P95} 抽内达成。
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
    </header>
  );
}
