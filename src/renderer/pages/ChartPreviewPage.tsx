import { ChartColumn } from "lucide-react";
import { WorkbenchIcon } from "../components/WorkbenchIcon";
import { Button } from "../components/Button";
import type { CDFViewModel } from "../../visualize/types/cdf";
import {
  ANIMATION_TOTAL_MS,
  quantile_reveal_frames,
} from "../../visualize/animation/timeline";
import { build_animation_progress } from "../../visualize/animation/progress";
import { ChartPreview } from "../../visualize/components/ChartPreview";
import { CDF_CHART_SIZE } from "../../visualize/view/scene_layout";
import { CDFChart } from "../../visualize/components/CDFChart";

export function ChartPreviewPage({
  data,
  on_return,
}: {
  data: CDFViewModel;
  on_return: () => void;
}) {
  return (
    <section className="renderer-placeholder chart-preview-page">
      <header className="page-heading chart-preview-header">
        <div className="renderer-placeholder-mark" aria-hidden="true">
          <WorkbenchIcon icon={ChartColumn} size={20} />
        </div>
        <h1 className="page-title">图表预览</h1>
        <Button variant="secondary" onClick={on_return}>
          返回完整画面
        </Button>
      </header>
      <section
        className="instrument-panel result-cdf-preview"
        data-testid="result-cdf-preview"
      >
        <div className="panel-heading">
          <div>
            <p className="panel-kicker">CDF</p>
            <h2 className="panel-title">模拟结果分布</h2>
          </div>
        </div>
        <dl className="preview-summary">
          <div>
            <dt>结果指标</dt>
            <dd>
              <code>{data.result_item.id}</code>
            </dd>
          </div>
          <div>
            <dt>累计模拟次数</dt>
            <dd>{data.runs.toLocaleString("zh-CN")}</dd>
          </div>
          <div>
            <dt>统计物品总量</dt>
            <dd>
              {data.total_result.toLocaleString("zh-CN")}
              {data.result_item_unit && (
                <small className="preview-summary-unit">
                  {` ${data.result_item_unit}`}
                </small>
              )}
            </dd>
          </div>
        </dl>
        <div className="result-cdf-chart workbench-scroll-region">
          <ChartPreview size={CDF_CHART_SIZE}>
            <CDFChart
              size={CDF_CHART_SIZE}
              animation_progress={build_animation_progress(
                ANIMATION_TOTAL_MS,
                quantile_reveal_frames(data),
              )}
              data={data}
            />
          </ChartPreview>
        </div>
      </section>
    </section>
  );
}
