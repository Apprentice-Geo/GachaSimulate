import { WorkbenchIcon } from "./components/WorkbenchIcon";
import { Button } from "./components/Button";
import { Field } from "./components/Field";
import { FileImage, Film, X } from "lucide-react";
import type {
  ExportFlow,
  ExportNotice,
  ExportWorkflowController,
  ExportWorkflowState,
} from "./export_workflow_controller";

export type ExportDialogActions = Pick<
  ExportWorkflowController,
  | "set_base_name"
  | "toggle_format"
  | "cancel_or_return"
  | "confirm_overwrite"
  | "confirm_cancel"
  | "retry_cleanup"
  | "exit_after_cleanup"
> & { start_preparation: () => void };

export function ExportNoticeView({
  notice,
  on_open_directory,
  on_dismiss,
}: {
  notice: ExportNotice;
  on_open_directory: () => void;
  on_dismiss: () => void;
}) {
  return (
    <div className="export-notice" data-kind={notice.kind} role="status">
      <div>
        <strong>{notice.message}</strong>
        {Boolean(notice.saved?.length) && (
          <span className="export-notice-detail">
            已保存：
            {notice.saved!.map((value) => value.toUpperCase()).join("、")}
          </span>
        )}
        {Boolean(notice.failed?.length) && (
          <span className="export-notice-detail">
            失败：
            {notice.failed!.map((value) => value.toUpperCase()).join("、")}
          </span>
        )}
      </div>
      {notice.task_id && Boolean(notice.saved?.length) && (
        <Button
          className="export-notice-action"
          variant="ghost"
          size="compact"
          type="button"
          onClick={on_open_directory}
        >
          打开所在文件夹
        </Button>
      )}
      <Button
        className="export-notice-action"
        variant="ghost"
        size="compact"
        type="button"
        aria-label="关闭通知"
        onClick={on_dismiss}
      >
        <WorkbenchIcon icon={X} aria-hidden="true" size={16} />
      </Button>
    </div>
  );
}

function ExportEditor({
  state,
  flow,
  actions,
}: {
  state: ExportWorkflowState;
  flow: Extract<ExportFlow, { phase: "editing" }>;
  actions: ExportDialogActions;
}) {
  const { base_name, formats, validation_error } = state;
  const { editing_focus } = flow;
  const { set_base_name, toggle_format, cancel_or_return, start_preparation } =
    actions;
  return (
    <>
      <header className="export-heading">
        <div>
          <p className="export-eyebrow">EXPORT MATERIALS</p>
          <h2 className="export-title" id="export-dialog-title">
            导出素材
          </h2>
        </div>
        <Button
          variant="ghost"
          size="compact"
          type="button"
          aria-label="关闭导出"
          onClick={cancel_or_return}
        >
          <WorkbenchIcon icon={X} aria-hidden="true" size={18} />
        </Button>
      </header>
      <fieldset className="export-format-options">
        <legend>选择格式</legend>
        <label className="export-format-option">
          <input
            checked={formats.includes("mp4")}
            type="checkbox"
            onChange={() => toggle_format("mp4")}
          />
          <WorkbenchIcon icon={Film} aria-hidden="true" size={20} />
          <span className="export-format-copy">
            <strong>MP4 动画</strong>
            <small>60 FPS · H.264</small>
          </span>
        </label>
        <label className="export-format-option">
          <input
            checked={formats.includes("png")}
            type="checkbox"
            onChange={() => toggle_format("png")}
          />
          <WorkbenchIcon icon={FileImage} aria-hidden="true" size={20} />
          <span className="export-format-copy">
            <strong>PNG 静帧</strong>
            <small>动画完成画面</small>
          </span>
        </label>
      </fieldset>
      <Field className="export-name-field">
        文件名
        <input
          className="export-name-input"
          data-autofocus={editing_focus === "name" || undefined}
          value={base_name}
          onChange={(event) => set_base_name(event.target.value)}
        />
      </Field>
      <div className="export-preview" aria-label="文件名预览">
        {formats.map((format) => `${base_name || "—"}.${format}`).join("  ·  ")}
      </div>
      {validation_error && (
        <p className="export-validation" role="alert">
          {validation_error}
        </p>
      )}
      <footer className="export-actions">
        <Button type="button" variant="secondary" onClick={cancel_or_return}>
          取消
        </Button>
        <Button
          data-action="choose-directory"
          data-autofocus={editing_focus === "directory" || undefined}
          type="button"
          disabled={Boolean(validation_error)}
          onClick={() => void start_preparation()}
        >
          选择导出目录
        </Button>
      </footer>
    </>
  );
}

export function ExportDialogContent({
  state,
  actions,
}: {
  state: ExportWorkflowState;
  actions: ExportDialogActions;
}) {
  const { flow, base_name, formats } = state;
  const { phase } = flow;
  const {
    cancel_or_return,
    confirm_overwrite,
    confirm_cancel,
    retry_cleanup,
    exit_after_cleanup,
  } = actions;
  if (phase === "closed") return null;
  if (phase === "editing")
    return <ExportEditor state={state} flow={flow} actions={actions} />;
  return phase === "confirming_overwrite" ? (
    <>
      <header className="export-heading">
        <div>
          <p className="export-eyebrow">OVERWRITE CHECK</p>
          <h2 className="export-title" id="export-dialog-title">
            覆盖现有文件？
          </h2>
        </div>
        <Button
          variant="ghost"
          size="compact"
          type="button"
          aria-label="返回格式选择"
          onClick={cancel_or_return}
        >
          <WorkbenchIcon icon={X} aria-hidden="true" size={18} />
        </Button>
      </header>
      <p className="export-copy">
        以下文件已存在。继续后会在提交每个产物前再次确认文件未被其他程序改动。
      </p>
      <ul>
        {flow.overwrite_files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
      <footer className="export-actions">
        <Button
          data-autofocus
          type="button"
          variant="secondary"
          onClick={cancel_or_return}
        >
          返回
        </Button>
        <Button type="button" onClick={() => void confirm_overwrite()}>
          覆盖并导出
        </Button>
      </footer>
    </>
  ) : phase === "cancel_confirm" ? (
    <>
      <header className="export-heading">
        <div>
          <p className="export-eyebrow">CANCEL EXPORT</p>
          <h2 className="export-title" id="export-dialog-title">
            确定取消导出？
          </h2>
        </div>
      </header>
      <p className="export-copy">
        已经提交完成的文件会保留；尚未提交的产物将停止处理。
      </p>
      <footer className="export-actions">
        <Button
          data-autofocus
          type="button"
          variant="secondary"
          onClick={cancel_or_return}
        >
          继续导出
        </Button>
        <Button type="button" onClick={confirm_cancel}>
          确定取消
        </Button>
      </footer>
    </>
  ) : phase === "cleanup_blocked" || phase === "cleanup_retrying" ? (
    <>
      <header className="export-heading">
        <div>
          <p className="export-eyebrow">EXPORT CLEANUP</p>
          <h2 className="export-title" id="export-dialog-title">
            导出资源清理失败
          </h2>
        </div>
      </header>
      {flow.terminal && (
        <div className="export-task-summary">
          <strong>
            {flow.terminal.type === "completed"
              ? "文件已保存"
              : flow.terminal.type === "cancelled"
                ? "导出已取消"
                : "导出失败"}
          </strong>
          {flow.terminal.saved.length > 0 && (
            <span className="export-summary-meta">
              已保存：
              {flow.terminal.saved
                .map(({ format }) => format.toUpperCase())
                .join("、")}
            </span>
          )}
        </div>
      )}
      <p className="export-validation">{flow.cleanup_error}</p>
      {flow.residual_files.length > 0 && (
        <ul aria-label="残留文件">
          {flow.residual_files.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      )}
      <footer className="export-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={phase === "cleanup_retrying"}
          onClick={exit_after_cleanup}
        >
          退出应用
        </Button>
        <Button
          data-autofocus
          type="button"
          disabled={phase === "cleanup_retrying"}
          onClick={retry_cleanup}
        >
          {phase === "cleanup_retrying" ? "正在清理…" : "重试清理"}
        </Button>
      </footer>
    </>
  ) : (
    <>
      <header className="export-heading">
        <div>
          <p className="export-eyebrow">
            {phase === "started" || phase === "cancelling"
              ? "EXPORT TASK"
              : "PREPARING EXPORT"}
          </p>
          <h2 className="export-title" id="export-dialog-title">
            {phase === "started"
              ? "正在导出素材"
              : phase === "cancelling"
                ? "正在取消导出"
                : phase === "choosing_destination"
                  ? "选择导出目录"
                  : "正在准备导出"}
          </h2>
        </div>
      </header>
      <div className="export-task-summary">
        <strong>{base_name}</strong>
        <span className="export-summary-meta">
          {formats.map((format) => format.toUpperCase()).join(" + ")}
        </span>
        <p className="export-copy">
          {phase === "choosing_destination"
            ? "请在系统窗口中选择目录。"
            : "导出期间应用暂时不可操作。"}
        </p>
        {phase === "started" && (
          <>
            <p className="export-stage-copy">
              {flow.progress.stage === "preparing"
                ? "正在启动导出 renderer"
                : flow.progress.stage === "rendering"
                  ? flow.progress.completed !== undefined && flow.progress.total
                    ? `正在渲染第 ${flow.progress.completed} / ${flow.progress.total} 帧`
                    : "正在渲染素材"
                  : flow.progress.format
                    ? `正在提交 ${flow.progress.format.toUpperCase()}（${flow.progress.committed ?? 0} / ${flow.progress.artifact_total ?? formats.length}）`
                    : "正在准备提交导出产物"}
            </p>
            {flow.progress.stage === "rendering" &&
            flow.progress.completed !== undefined &&
            flow.progress.total ? (
              <progress
                max={flow.progress.total}
                value={flow.progress.completed}
                aria-label="导出帧进度"
              />
            ) : flow.progress.stage === "finalizing" &&
              flow.progress.artifact_total !== undefined ? (
              <progress
                max={flow.progress.artifact_total}
                value={flow.progress.committed ?? 0}
                aria-label="导出产物提交进度"
              />
            ) : (
              <progress aria-label="导出进度不确定" />
            )}
            {formats.includes("png") && (
              <span className="export-png-status">
                PNG：{flow.png_written ? "静帧已写入" : "等待动画完成帧"}
              </span>
            )}
          </>
        )}
      </div>
      <footer className="export-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={phase === "handing_off" || phase === "cancelling"}
          onClick={cancel_or_return}
        >
          {phase === "cancelling" ? "正在取消…" : "取消导出"}
        </Button>
      </footer>
    </>
  );
}
