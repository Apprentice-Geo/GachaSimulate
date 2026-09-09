import { FileImage, Film, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  validate_export_base_name,
  validate_export_formats,
  type DesktopExportEvent,
  type ExportFormat,
} from "../shared/export_task";

export type ExportFlowPhase =
  | "closed"
  | "editing"
  | "preparing"
  | "choosing_destination"
  | "confirming_overwrite"
  | "handing_off"
  | "started"
  | "cancelling";

type ExportContext = Readonly<{
  session_id: string;
  default_base_name: string;
}> | null;

type ExportWorkflowProps = {
  context: ExportContext;
  children: (controls: { active: boolean; open: () => void }) => ReactNode;
};

type Notice = { kind: "success" | "cancelled" | "error"; message: string };

function message_of(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function use_focus_trap(
  dialog_ref: RefObject<HTMLDivElement | null>,
  active: boolean,
  focus_key: string,
  on_escape: () => void,
) {
  const escape_ref = useRef(on_escape);
  useEffect(() => void (escape_ref.current = on_escape), [on_escape]);
  useEffect(() => {
    if (!active) return;
    const dialog = dialog_ref.current;
    if (!dialog) return;
    const focusable = () =>
      [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => !element.hidden);
    (
      dialog.querySelector<HTMLElement>("[data-autofocus]") ?? focusable()[0]
    )?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        escape_ref.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [active, dialog_ref, focus_key]);
}

export function ExportWorkflow({ context, children }: ExportWorkflowProps) {
  const [phase, set_phase] = useState<ExportFlowPhase>("closed");
  const [formats, set_formats] = useState<ExportFormat[]>(["mp4", "png"]);
  const [base_name, set_base_name] = useState("");
  const [validation_error, set_validation_error] = useState<string | null>(
    null,
  );
  const [overwrite_files, set_overwrite_files] = useState<string[]>([]);
  const [reservation_id, set_reservation_id] = useState<string | null>(null);
  const [task_id, set_task_id] = useState<string | null>(null);
  const [notice, set_notice] = useState<Notice | null>(null);
  const [editing_focus, set_editing_focus] = useState<"name" | "directory">(
    "name",
  );
  const phase_ref = useRef(phase);
  const reservation_ref = useRef(reservation_id);
  const task_ref = useRef(task_id);
  const generation = useRef(0);
  const early_events = useRef(new Map<string, DesktopExportEvent>());
  const pending_cancel_reason = useRef<
    "cancelled" | "destination-returned" | null
  >(null);
  const trigger_ref = useRef<HTMLElement | null>(null);
  const dialog_ref = useRef<HTMLDivElement>(null);
  const active = phase !== "closed";

  useEffect(() => void (phase_ref.current = phase), [phase]);
  useEffect(
    () => void (reservation_ref.current = reservation_id),
    [reservation_id],
  );
  useEffect(() => void (task_ref.current = task_id), [task_id]);

  const finish = (next_notice: Notice | null) => {
    generation.current += 1;
    phase_ref.current = "closed";
    reservation_ref.current = null;
    task_ref.current = null;
    set_phase("closed");
    set_reservation_id(null);
    set_task_id(null);
    set_overwrite_files([]);
    set_notice(next_notice);
    queueMicrotask(() => trigger_ref.current?.focus());
  };

  const choose_destination = async (id: string, run: number) => {
    set_phase("choosing_destination");
    try {
      const result = await window.desktopApi.selectExportDestination({
        reservation_id: id,
      });
      if (generation.current !== run || reservation_ref.current !== id) return;
      if (result.status === "overwrite-required") {
        set_overwrite_files(result.files);
        set_phase("confirming_overwrite");
      } else if (result.status === "started") {
        task_ref.current = result.task_id;
        set_task_id(result.task_id);
        set_phase("started");
      }
    } catch (reason) {
      if (generation.current === run && reservation_ref.current === id)
        finish({ kind: "error", message: message_of(reason) });
    }
  };

  useEffect(() => {
    if (!window.desktopApi) return;
    return window.desktopApi.onExportEvent((event: DesktopExportEvent) => {
      if ("reservation_id" in event) {
        if (event.reservation_id !== reservation_ref.current) {
          if (
            event.type === "preparation-ready" ||
            event.type === "preparation-cancelled" ||
            event.type === "preparation-failed"
          )
            early_events.current.set(event.reservation_id, event);
          return;
        }
        if (event.type === "preparation-ready") {
          void choose_destination(event.reservation_id, generation.current);
        } else if (event.type === "preparation-cancelled") {
          if (event.reason === "destination-returned") {
            set_reservation_id(null);
            reservation_ref.current = null;
            set_editing_focus("directory");
            set_phase("editing");
          } else {
            finish({ kind: "cancelled", message: "已取消导出" });
          }
        } else if (event.type === "preparation-failed") {
          finish({ kind: "error", message: event.message });
        } else if (event.type === "started") {
          task_ref.current = event.task_id;
          set_task_id(event.task_id);
          set_phase("started");
        }
        return;
      }
      if (!("task_id" in event) || event.task_id !== task_ref.current) return;
      if (event.type === "completed")
        finish({ kind: "success", message: "导出完成" });
      else if (event.type === "cancelled")
        finish({ kind: "cancelled", message: "已取消导出" });
      else if (event.type === "failed")
        finish({ kind: "error", message: event.message });
    });
  }, []);

  const open = () => {
    if (!context || active) return;
    trigger_ref.current = document.activeElement as HTMLElement | null;
    generation.current += 1;
    set_formats(["mp4", "png"]);
    set_base_name(context.default_base_name);
    set_validation_error(null);
    set_editing_focus("name");
    set_notice(null);
    pending_cancel_reason.current = null;
    set_phase("editing");
  };

  const start_preparation = async () => {
    if (!context || phase_ref.current !== "editing") return;
    try {
      validate_export_base_name(base_name);
      validate_export_formats(formats);
      set_validation_error(null);
    } catch (reason) {
      set_validation_error(message_of(reason));
      return;
    }
    const run = ++generation.current;
    set_phase("preparing");
    try {
      const accepted = await window.desktopApi.prepareExport({
        session_id: context.session_id,
        formats,
        base_name,
      });
      if (generation.current !== run) return;
      set_reservation_id(accepted.reservation_id);
      reservation_ref.current = accepted.reservation_id;
      if (pending_cancel_reason.current) {
        void window.desktopApi.cancelExport({
          reservation_id: accepted.reservation_id,
          reason: pending_cancel_reason.current,
        });
        return;
      }
      const early = early_events.current.get(accepted.reservation_id);
      early_events.current.delete(accepted.reservation_id);
      if (early?.type === "preparation-ready")
        void choose_destination(accepted.reservation_id, run);
      else if (early?.type === "preparation-failed")
        finish({ kind: "error", message: early.message });
      else if (early?.type === "preparation-cancelled")
        finish(
          early.reason === "cancelled"
            ? { kind: "cancelled", message: "已取消导出" }
            : null,
        );
    } catch (reason) {
      if (generation.current === run)
        finish({ kind: "error", message: message_of(reason) });
    }
  };

  const cancel_or_return = () => {
    if (phase === "editing") {
      finish(null);
      return;
    }
    if (phase === "started" && task_id) {
      set_phase("cancelling");
      void window.desktopApi.cancelExport({ task_id });
      return;
    }
    if (!reservation_id) {
      if (phase === "preparing") {
        pending_cancel_reason.current = "cancelled";
        set_phase("cancelling");
      }
      return;
    }
    if (phase === "cancelling") return;
    const reason =
      phase === "confirming_overwrite" ? "destination-returned" : "cancelled";
    set_phase("cancelling");
    void window.desktopApi.cancelExport({ reservation_id, reason });
  };

  const confirm_overwrite = async () => {
    if (!reservation_id || phase !== "confirming_overwrite") return;
    const id = reservation_id;
    const run = generation.current;
    set_phase("handing_off");
    try {
      const result = await window.desktopApi.confirmExportOverwrite({
        reservation_id: id,
      });
      if (generation.current !== run || reservation_ref.current !== id) return;
      set_task_id(result.task_id);
      task_ref.current = result.task_id;
      set_phase("started");
    } catch (reason) {
      if (generation.current === run && reservation_ref.current === id)
        finish({ kind: "error", message: message_of(reason) });
    }
  };

  use_focus_trap(
    dialog_ref,
    active,
    `${phase}:${editing_focus}`,
    cancel_or_return,
  );

  const toggle_format = (format: ExportFormat) => {
    const next = formats.includes(format)
      ? formats.filter((value) => value !== format)
      : [...formats, format];
    set_formats(next);
    try {
      validate_export_formats(next);
      set_validation_error(null);
    } catch (reason) {
      set_validation_error(message_of(reason));
    }
  };

  return (
    <>
      <div className="export-background" inert={active ? true : undefined}>
        {children({ active, open })}
      </div>
      {notice && (
        <div className="export-notice" data-kind={notice.kind} role="status">
          <span>{notice.message}</span>
          <button
            type="button"
            aria-label="关闭通知"
            onClick={() => set_notice(null)}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      )}
      {active && (
        <div className="export-overlay" data-phase={phase}>
          <div
            aria-labelledby="export-dialog-title"
            aria-modal="true"
            className="export-dialog"
            ref={dialog_ref}
            role="dialog"
          >
            {phase === "editing" ? (
              <>
                <header>
                  <div>
                    <p>EXPORT MATERIALS</p>
                    <h2 id="export-dialog-title">导出素材</h2>
                  </div>
                  <button
                    type="button"
                    aria-label="关闭导出"
                    onClick={cancel_or_return}
                  >
                    <X aria-hidden="true" size={18} />
                  </button>
                </header>
                <fieldset className="export-format-options">
                  <legend>选择格式</legend>
                  <label>
                    <input
                      checked={formats.includes("mp4")}
                      type="checkbox"
                      onChange={() => toggle_format("mp4")}
                    />
                    <Film aria-hidden="true" size={20} />
                    <span>
                      <strong>MP4 动画</strong>
                      <small>60 FPS · H.264</small>
                    </span>
                  </label>
                  <label>
                    <input
                      checked={formats.includes("png")}
                      type="checkbox"
                      onChange={() => toggle_format("png")}
                    />
                    <FileImage aria-hidden="true" size={20} />
                    <span>
                      <strong>PNG 静帧</strong>
                      <small>动画完成画面</small>
                    </span>
                  </label>
                </fieldset>
                <label className="export-name-field">
                  文件名
                  <input
                    data-autofocus={editing_focus === "name" || undefined}
                    value={base_name}
                    onChange={(event) => {
                      set_base_name(event.target.value);
                      try {
                        validate_export_base_name(event.target.value);
                        set_validation_error(null);
                      } catch (reason) {
                        set_validation_error(message_of(reason));
                      }
                    }}
                  />
                </label>
                <div className="export-preview" aria-label="文件名预览">
                  {formats
                    .map((format) => `${base_name || "—"}.${format}`)
                    .join("  ·  ")}
                </div>
                {validation_error && (
                  <p className="export-validation" role="alert">
                    {validation_error}
                  </p>
                )}
                <footer>
                  <button
                    type="button"
                    className="secondary"
                    onClick={cancel_or_return}
                  >
                    取消
                  </button>
                  <button
                    data-action="choose-directory"
                    data-autofocus={editing_focus === "directory" || undefined}
                    type="button"
                    disabled={Boolean(validation_error)}
                    onClick={() => void start_preparation()}
                  >
                    选择导出目录
                  </button>
                </footer>
              </>
            ) : phase === "confirming_overwrite" ? (
              <>
                <header>
                  <div>
                    <p>OVERWRITE CHECK</p>
                    <h2 id="export-dialog-title">覆盖现有文件？</h2>
                  </div>
                  <button
                    type="button"
                    aria-label="返回格式选择"
                    onClick={cancel_or_return}
                  >
                    <X aria-hidden="true" size={18} />
                  </button>
                </header>
                <p className="export-copy">
                  以下文件已存在。继续后会在提交每个产物前再次确认文件未被其他程序改动。
                </p>
                <ul>
                  {overwrite_files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
                <footer>
                  <button
                    data-autofocus
                    type="button"
                    className="secondary"
                    onClick={cancel_or_return}
                  >
                    返回
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirm_overwrite()}
                  >
                    覆盖并导出
                  </button>
                </footer>
              </>
            ) : (
              <>
                <header>
                  <div>
                    <p>
                      {phase === "started" || phase === "cancelling"
                        ? "EXPORT TASK"
                        : "PREPARING EXPORT"}
                    </p>
                    <h2 id="export-dialog-title">
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
                  <span>
                    {formats.map((format) => format.toUpperCase()).join(" + ")}
                  </span>
                  <p>
                    {phase === "choosing_destination"
                      ? "请在系统窗口中选择目录。"
                      : "导出期间应用暂时不可操作。"}
                  </p>
                </div>
                <footer>
                  <button
                    type="button"
                    className="secondary"
                    disabled={phase === "handing_off" || phase === "cancelling"}
                    onClick={cancel_or_return}
                  >
                    {phase === "cancelling" ? "正在取消…" : "取消导出"}
                  </button>
                </footer>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
