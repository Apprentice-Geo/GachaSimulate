import { FilePenLine } from "lucide-react";
import { useState, useEffect, useRef, useMemo } from "react";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { ResultLoadPanel } from "../components/ResultLoadPanel";
import type {
  DisplayFields,
  ResultEditorState,
} from "../../shared/result_editor";
import { ANIMATION_TOTAL_MS } from "../../visualize/animation/timeline";
import { build_animation_progress } from "../../visualize/animation/progress";
import { ChartPreview } from "../../visualize/components/ChartPreview";
import { CDF_CHART_SIZE } from "../../visualize/view/scene_layout";
import { CDFChart } from "../../visualize/components/CDFChart";
import { build_cdf_view_model } from "../../visualize/view/cdf_view_model";

export function ResultEditorPage({
  state,
  on_state,
}: {
  state: ResultEditorState | null;
  on_state: (state: ResultEditorState) => void;
}) {
  const [fields, set_fields] = useState<DisplayFields | null>(null);
  const [status, set_status] = useState<string | undefined>();
  const [loading, set_loading] = useState(false);
  const [saving, set_saving] = useState(false);
  const [error, set_error] = useState<string | null>(null);
  const fields_ref = useRef<DisplayFields | null>(null);
  const save_queue = useRef(Promise.resolve());
  const save_version = useRef(0);
  const preview_data =
    state && fields
      ? build_cdf_view_model(state.analysis, { ...state.display, ...fields })
      : null;
  const preview_animation = useMemo(
    () => build_animation_progress(ANIMATION_TOTAL_MS),
    [],
  );

  const apply_state = (next: ResultEditorState) => {
    on_state(next);
    fields_ref.current = next.fields;
    set_fields(next.fields);
  };

  useEffect(() => {
    fields_ref.current = state?.fields ?? null;
    set_fields(fields_ref.current);
  }, [state]);

  const select = async () => {
    set_loading(true);
    set_error(null);
    set_status("正在分析…");
    try {
      const next = await window.desktopApi.selectGsrResult();
      if (next) {
        apply_state(next);
        set_status("分析完成，尚无未保存更改。");
      } else {
        set_status("未选择文件。");
      }
    } catch (reason) {
      set_error(reason instanceof Error ? reason.message : String(reason));
      set_status("分析失败。");
    } finally {
      set_loading(false);
    }
  };

  const save = () => {
    const snapshot = fields_ref.current;
    if (!snapshot) return;
    const version = ++save_version.current;
    set_saving(true);
    set_error(null);
    set_status("正在保存…");
    save_queue.current = save_queue.current.then(async () => {
      try {
        if (!state) throw new Error("result session is unavailable");
        const next = await window.desktopApi.saveResultFields({
          session_id: state.session_id,
          fields: snapshot,
        });
        if (version === save_version.current) {
          if (fields_ref.current === snapshot) apply_state(next);
          set_status("已保存。");
        }
      } catch (reason) {
        if (version === save_version.current) {
          set_error(reason instanceof Error ? reason.message : String(reason));
          set_status("保存失败，现有 sidecar 未被覆盖。");
        }
      } finally {
        if (version === save_version.current) set_saving(false);
      }
    });
  };

  const change_field = (key: keyof DisplayFields, value: string) =>
    set_fields((current) => {
      if (!current) return current;
      fields_ref.current = { ...current, [key]: value };
      return fields_ref.current;
    });

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
            <FilePenLine size={20} />
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
            <div className="result-editor-fields">
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
            <div className="result-cdf-chart">
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
      {state && error && (
        <p className="simulation-error" role="alert">
          错误：{error}
        </p>
      )}
    </section>
  );
}
