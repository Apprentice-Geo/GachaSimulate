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

  return (
    <header className="top-bar">
      <div
        className="title-stack"
        style={
          animation_progress
            ? metric_style(animation_progress.title_area)
            : undefined
        }
      >
        <div className="section-kicker">CDF ANALYSIS</div>
        <h1>{data?.title ?? "抽卡模拟 CDF 分析"}</h1>
        {data && (
          <p>
            半数模拟 {data.statistic.P50} 抽内达成，95% 模拟{" "}
            {data.statistic.P95} 抽内达成。
          </p>
        )}
      </div>
      <div
        className="top-meta"
        aria-label="模拟元信息"
        style={
          animation_progress
            ? metric_style(animation_progress.metadata)
            : undefined
        }
      >
        {metadata_items.map((item) => (
          <div key={item}>{item}</div>
        ))}
      </div>
    </header>
  );
}
