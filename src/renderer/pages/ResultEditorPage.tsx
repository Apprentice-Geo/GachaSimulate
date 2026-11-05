import { WorkbenchIcon } from "../components/WorkbenchIcon";
import { FilePenLine } from "lucide-react";
import { useMemo } from "react";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { ResultLoadPanel } from "../components/ResultLoadPanel";
import type { DisplayFields } from "../../shared/result_editor";
import type {
  ResultSessionController,
  ResultSessionState,
} from "../result_session_controller";
import { ANIMATION_TOTAL_MS } from "../../visualize/animation/timeline";
import { build_animation_progress } from "../../visualize/animation/progress";
import { ChartPreview } from "../../visualize/components/ChartPreview";
import { CDF_CHART_SIZE } from "../../visualize/view/scene_layout";
import { CDFChart } from "../../visualize/components/CDFChart";

export function ResultEditorPage({
  session,
  controller,
}: {
  session: ResultSessionState;
  controller: ResultSessionController;
}) {
  const {
    result: state,
    draft: fields,
    preview: preview_data,
    loading,
    saving,
    status,
  } = session;
  const error = session.load_error ?? session.save_error;
  const preview_animation = useMemo(
    () => build_animation_progress(ANIMATION_TOTAL_MS),
    [],
  );
  const select = controller.select_result;
  const save = () => void controller.save().catch(() => undefined);
  const change_field = controller.change_field;

  const field = (key: keyof DisplayFields, label: string, class_name = "") => (
    <Field className={class_name}>
      {label}
      <textarea
        className="field-control result-editor-textarea"
        aria-label={label}
        rows={1}
        wrap="soft"
        disabled={loading}
        value={fields?.[key] ?? ""}
        onBlur={save}
        onChange={(event) => change_field(key, event.target.value)}
      />
    </Field>
  );

  return (
    <section className="renderer-placeholder result-editor">
      {state && (
        <header className="page-heading result-editor-header">
          <div className="renderer-placeholder-mark" aria-hidden="true">
            <WorkbenchIcon icon={FilePenLine} size={20} />
          </div>
          <div>
            <p className="renderer-eyebrow">GSR RESULT EDITOR</p>
            <h1 className="page-title">结果展示信息</h1>
          </div>
          <Button
            variant="secondary"
            type="button"
            disabled={loading || saving}
            onClick={() => void select()}
          >
            更换 GSR
          </Button>
        </header>
      )}
      {!state && (
        <ResultLoadPanel
          description="选择 GSR 文件并完成分析后，即可编辑标题、目标、说明、副标题和统计物品展示单位。"
          loading={loading || saving}
          error={error}
          status={status}
          on_select={() => void select()}
        />
      )}
      {state && fields && preview_data && (
        <div className="result-editor-workbench">
          <div className="instrument-panel result-editor-form">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">展示字段 / DISPLAY</p>
                <h2 className="panel-title">可视化文案</h2>
              </div>
              <span className="panel-status">失焦自动保存</span>
            </div>
            <dl className="result-editor-summary">
              <div>
                <dt>结果指标</dt>
                <dd>
                  <code>{state.analysis.result_item.id}</code>
                </dd>
              </div>
              <div>
                <dt>累计模拟次数</dt>
                <dd>{preview_data.runs.toLocaleString("zh-CN")}</dd>
              </div>
              <div>
                <dt>累计次数</dt>
                <dd>
                  {preview_data.total_result.toLocaleString("zh-CN")}
                  {fields.result_item_unit && (
                    <small className="result-editor-summary-unit">
                      {` ${fields.result_item_unit}`}
                    </small>
                  )}
                </dd>
              </div>
            </dl>
            <div className="result-editor-fields workbench-scroll-region">
              {field("title", "标题")}
              {field("target", "目标")}
              {field("result_item_name", "统计物品展示名称")}
              {field("note", "说明", "result-note")}
              {field("subtitle", "副标题", "result-subtitle")}
              {field(
                "result_item_unit",
                "统计物品展示单位",
                "result-item-unit",
              )}
            </div>
          </div>
          <aside
            className="instrument-panel result-cdf-preview"
            data-testid="result-cdf-preview"
          >
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">分布 / DISTRIBUTION</p>
                <h2 className="panel-title">可视化预览</h2>
              </div>
            </div>
            <div className="result-cdf-chart workbench-scroll-region">
              <ChartPreview size={CDF_CHART_SIZE}>
                <CDFChart
                  size={CDF_CHART_SIZE}
                  animation_progress={preview_animation}
                  data={preview_data}
                />
              </ChartPreview>
            </div>
          </aside>
        </div>
      )}
      {state && (
        <p className="result-save-status" role="status">
          {status}
        </p>
      )}
      {state && session.save_error && (
        <Button
          type="button"
          variant="secondary"
          disabled={loading || saving}
          onClick={save}
        >
          重试保存
        </Button>
      )}
      {state && error && (
        <p className="simulation-error" role="alert">
          错误：{error}
        </p>
      )}
    </section>
  );
}
