import { useState } from "react";
import { createPortal } from "react-dom";
import VisualizeApp from "../../visualize/App";
import type { DisplayField } from "../../visualize/components/TopBar";
import { ResultLoadPanel } from "../components/ResultLoadPanel";
import { Button } from "../components/Button";
import {
  fields_equal,
  type ResultSessionController,
  type ResultSessionState,
} from "../result_session_controller";

const field_labels: Record<DisplayField, string> = {
  title: "标题",
  subtitle: "副标题",
  target: "模拟目标",
  note: "说明",
  result_item_name: "统计物品名称",
  result_item_unit: "单位",
};

function save_status(session: ResultSessionState) {
  if (session.saving) return "正在保存…";
  if (session.save_error) return "保存失败";
  if (
    session.result &&
    session.draft &&
    !fields_equal(session.draft, session.result.fields)
  )
    return "尚未保存";
  return session.status === "已保存。" ? "已保存" : "自动保存";
}

export function ResultVisualizePage({
  controller,
  on_preview,
  on_select_result,
  on_export,
  export_active,
  actions_host,
  session,
}: {
  controller: ResultSessionController;
  on_preview: () => void;
  session: ResultSessionState;
  on_select_result: () => Promise<boolean>;
  on_export: () => void;
  export_active: boolean;
  actions_host: HTMLElement | null;
}) {
  const { loading, load_error: error, load_status: status } = session;
  const select = on_select_result;
  const [edit_mode, set_edit_mode] = useState(!!session.save_error);
  const [finishing, set_finishing] = useState(false);
  const [last_field, set_last_field] = useState<DisplayField>("title");
  const editing = edit_mode || !!session.save_error;
  const input = editing ? session.preview : session.model;
  const save = () => {
    set_edit_mode(true);
    void controller.save().catch(() => undefined);
  };
  const finish = async () => {
    set_finishing(true);
    try {
      await controller.save();
      if (!controller.get_snapshot().save_error) set_edit_mode(false);
    } catch {
      // The session retains the draft and reports the failure beside the field.
    } finally {
      set_finishing(false);
    }
  };

  const render_field = (field: DisplayField) => (
    <span className="scene-edit-field" data-field={field}>
      <textarea
        rows={1}
        aria-label={field_labels[field]}
        placeholder={`添加${field_labels[field]}`}
        readOnly={finishing}
        value={session.draft?.[field] ?? ""}
        onChange={(event) => {
          set_last_field(field);
          controller.change_field(field, event.currentTarget.value);
        }}
        onBlur={save}
      />
      {session.save_error && last_field === field && (
        <span className="scene-save-error" role="alert">
          保存失败：{session.save_error}
          <button type="button" onClick={save}>
            重试保存
          </button>
        </span>
      )}
    </span>
  );

  if (input) {
    return (
      <section className="result-visualize-loaded">
        <VisualizeApp
          edit={editing ? render_field : undefined}
          input={input}
          render_controls={({ replay, is_animating }) =>
            actions_host &&
            createPortal(
              <div
                className="visualize-sidebar-actions"
                role="group"
                aria-label="可视化操作"
              >
                <Button
                  variant="ghost"
                  disabled={finishing || loading || export_active}
                  onClick={() =>
                    editing ? void finish() : set_edit_mode(true)
                  }
                >
                  {editing ? "完成编辑" : "编辑"}
                </Button>
                {editing ? (
                  <span className="sidebar-save-status" role="status">
                    {save_status(session)}
                  </span>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      disabled={loading || export_active}
                      onClick={on_preview}
                    >
                      图表预览
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={loading || export_active}
                      onClick={() => void select()}
                    >
                      更换结果
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={is_animating || loading || export_active}
                      onClick={replay}
                    >
                      重播动画
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={loading || export_active}
                      onClick={on_export}
                    >
                      导出素材
                    </Button>
                  </>
                )}
              </div>,
              actions_host,
            )
          }
        />
        {!editing && (status || error) && (
          <div className="result-visualize-feedback">
            {status && <p role="status">{status}</p>}
            {error && (
              <p className="simulation-error" role="alert">
                错误：{error}
              </p>
            )}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="renderer-placeholder result-load-page">
      <ResultLoadPanel
        description="选择 GSR 文件并完成分析后，即可查看 CDF 曲线、核心统计量和达成路径分布。"
        loading={loading}
        error={error}
        status={status}
        on_select={() => void select()}
      />
    </section>
  );
}
