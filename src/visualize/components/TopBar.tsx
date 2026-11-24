import type { ReactNode } from "react";
import type { DisplayConfig } from "../types/display_config";
import { metric_style } from "../animation/progress";
import type { AnimationProgress } from "../animation/progress";
import type { CDFViewModel } from "../types/cdf";
import { ResultValue } from "./ResultValue";

export type DisplayField = Exclude<keyof DisplayConfig, "display_version">;
export type RenderDisplayField = (field: DisplayField) => ReactNode;

interface TopBarProps {
  edit?: RenderDisplayField;
  data: CDFViewModel;
  animation_progress: AnimationProgress;
}

export function TopBar({ data, animation_progress, edit }: TopBarProps) {
  const metadata_items = [
    {
      key: "target",
      label: "模拟目标",
      content: edit?.("target") ?? data.target,
    },
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
      label: <>累计{edit?.("result_item_name") ?? data.result_item.name}</>,
      content: (
        <span className="metadata-value">
          <ResultValue
            value={data.total_result_display}
            unit={data.result_item_unit}
          />
        </span>
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
          <h1 style={title_style(0)}>{edit?.("title") ?? data.title}</h1>
          {(edit || data.subtitle) && (
            <p className="outline" style={title_style(1)}>
              {edit?.("subtitle") ?? data.subtitle}
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
