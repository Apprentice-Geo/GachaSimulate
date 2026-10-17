import {
  validate_export_base_name,
  validate_export_formats,
  type DesktopExportEvent,
  type ExportCancelRequest,
  type ExportFormat,
  type ExportPreparationEvent,
} from "../shared/export_task";
import type { DesktopApi } from "../shared/installed_config";

export type ExportContext = Readonly<{
  session_id: string;
  default_base_name: string;
}> | null;

export type ExportNotice = Readonly<{
  kind: "success" | "cancelled" | "error";
  message: string;
  task_id?: string;
  saved?: readonly ExportFormat[];
  failed?: readonly ExportFormat[];
}>;

type TerminalEvent = Extract<
  DesktopExportEvent,
  { type: "completed" | "cancelled" | "failed" }
>;
type Progress = Extract<DesktopExportEvent, { type: "progress" }>;
type RunningFlow = Readonly<{
  phase: "started" | "cancel_confirm";
  task_id: string;
  progress: Omit<Progress, "type" | "task_id">;
  png_written: boolean;
}>;
type CleanupFlow = Readonly<{
  phase: "cleanup_blocked" | "cleanup_retrying";
  task_id: string;
  terminal: TerminalEvent;
  cleanup_error: string;
  residual_files: readonly string[];
}>;

export type ExportFlow =
  | Readonly<{ phase: "closed" }>
  | Readonly<{ phase: "editing"; editing_focus: "name" | "directory" }>
  | Readonly<{ phase: "preparing"; reservation_id: string | null }>
  | Readonly<{
      phase: "choosing_destination" | "handing_off";
      reservation_id: string;
    }>
  | Readonly<{
      phase: "confirming_overwrite";
      reservation_id: string;
      overwrite_files: readonly string[];
    }>
  | RunningFlow
  | Readonly<{
      phase: "cancelling";
      target:
        | ExportCancelRequest
        | { reservation_id: null; reason: "cancelled" };
    }>
  | CleanupFlow;

export type ExportWorkflowState = Readonly<{
  flow: ExportFlow;
  formats: readonly ExportFormat[];
  base_name: string;
  validation_error: string | null;
  notice: ExportNotice | null;
  live_message: string;
}>;

export type ExportWorkflowApi = Pick<
  DesktopApi,
  | "prepareExport"
  | "selectExportDestination"
  | "confirmExportOverwrite"
  | "cancelExport"
  | "retryExportCleanup"
  | "openExportDirectory"
  | "exitAfterExportCleanup"
  | "onExportEvent"
>;

function message_of(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function notice_for_terminal(event: TerminalEvent): ExportNotice {
  return {
    kind:
      event.type === "completed"
        ? "success"
        : event.type === "cancelled"
          ? "cancelled"
          : "error",
    message:
      event.type === "completed"
        ? "导出完成"
        : event.type === "cancelled"
          ? "已取消导出"
          : event.message,
    task_id: event.task_id,
    saved: event.saved.map(({ format }) => format),
    failed: event.failed,
  };
}

function reservation_of(flow: ExportFlow): string | null {
  if ("reservation_id" in flow) return flow.reservation_id;
  if (flow.phase === "cancelling" && "reservation_id" in flow.target)
    return flow.target.reservation_id ?? null;
  return null;
}

function task_of(flow: ExportFlow): string | null {
  if ("task_id" in flow) return flow.task_id;
  if (flow.phase === "cancelling" && "task_id" in flow.target)
    return flow.target.task_id ?? null;
  return null;
}

/** Renderer-side interaction state. Main remains the authority for export work. */
export class ExportWorkflowController {
  private state: ExportWorkflowState = {
    flow: { phase: "closed" },
    formats: ["mp4", "png"],
    base_name: "",
    validation_error: null,
    notice: null,
    live_message: "",
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private cleanup_attempt = 0;
  private readonly early_events = new Map<string, ExportPreparationEvent>();

  constructor(private readonly api: ExportWorkflowApi) {}

  get_snapshot = (): ExportWorkflowState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  connect = (): (() => void) => {
    const unsubscribe = this.api?.onExportEvent(this.on_event);
    return () => {
      unsubscribe?.();
      this.generation += 1;
      this.early_events.clear();
    };
  };

  private update(patch: Partial<ExportWorkflowState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private transition(
    flow: ExportFlow,
    patch: Partial<Omit<ExportWorkflowState, "flow">> = {},
  ): void {
    this.update({ ...patch, flow });
  }

  private finish(notice: ExportNotice | null): void {
    this.generation += 1;
    this.early_events.clear();
    this.transition({ phase: "closed" }, { notice, live_message: "" });
  }

  open = (context: ExportContext): boolean => {
    if (!context || this.state.flow.phase !== "closed") return false;
    this.generation += 1;
    this.early_events.clear();
    this.transition(
      { phase: "editing", editing_focus: "name" },
      {
        formats: ["mp4", "png"],
        base_name: context.default_base_name,
        validation_error: null,
        notice: null,
        live_message: "",
      },
    );
    return true;
  };

  private validation_error(
    base_name: string,
    formats: readonly ExportFormat[],
  ) {
    try {
      validate_export_base_name(base_name);
      validate_export_formats(formats);
      return null;
    } catch (reason) {
      return message_of(reason);
    }
  }

  set_base_name = (base_name: string): void => {
    if (this.state.flow.phase !== "editing") return;
    this.update({
      base_name,
      validation_error: this.validation_error(base_name, this.state.formats),
    });
  };

  toggle_format = (format: ExportFormat): void => {
    if (this.state.flow.phase !== "editing") return;
    const formats = this.state.formats.includes(format)
      ? this.state.formats.filter((value) => value !== format)
      : [...this.state.formats, format];
    this.update({
      formats,
      validation_error: this.validation_error(this.state.base_name, formats),
    });
  };

  start_preparation = async (context: ExportContext): Promise<void> => {
    if (!context || this.state.flow.phase !== "editing") return;
    const { base_name, formats } = this.state;
    const validation_error = this.validation_error(base_name, formats);
    if (validation_error) {
      this.update({ validation_error });
      return;
    }
    const run = ++this.generation;
    this.transition(
      { phase: "preparing", reservation_id: null },
      { validation_error: null },
    );
    try {
      const { reservation_id } = await this.api.prepareExport({
        session_id: context.session_id,
        base_name,
        formats: [...formats],
      });
      if (run !== this.generation) return;
      const flow = this.get_snapshot().flow;
      if (flow.phase === "preparing") {
        this.transition({ ...flow, reservation_id });
      } else if (flow.phase === "cancelling") {
        this.transition({
          ...flow,
          target: { reservation_id, reason: "cancelled" },
        });
      } else return;
      const early = this.early_events.get(reservation_id);
      this.early_events.clear();
      if (early) this.on_event(early);
      const current = this.get_snapshot().flow;
      if (
        run === this.generation &&
        current.phase === "cancelling" &&
        current.target.reservation_id
      ) {
        await this.send_cancel(current.target, {
          phase: "preparing",
          reservation_id,
        });
      }
    } catch (reason) {
      if (run === this.generation)
        this.finish({ kind: "error", message: message_of(reason) });
    }
  };

  private async choose_destination(reservation_id: string): Promise<void> {
    const run = this.generation;
    this.transition({ phase: "choosing_destination", reservation_id });
    try {
      const result = await this.api.selectExportDestination({ reservation_id });
      if (run !== this.generation) return;
      if (result.status === "started") {
        this.started(reservation_id, result.task_id);
      } else if (
        result.status === "overwrite-required" &&
        this.state.flow.phase === "choosing_destination" &&
        reservation_of(this.state.flow) === reservation_id
      ) {
        this.transition({
          phase: "confirming_overwrite",
          reservation_id,
          overwrite_files: result.files,
        });
      }
    } catch (reason) {
      if (
        run === this.generation &&
        reservation_of(this.state.flow) === reservation_id
      )
        this.finish({ kind: "error", message: message_of(reason) });
    }
  }

  confirm_overwrite = async (): Promise<void> => {
    const flow = this.state.flow;
    if (flow.phase !== "confirming_overwrite") return;
    const { reservation_id } = flow;
    const run = this.generation;
    this.transition({ phase: "handing_off", reservation_id });
    try {
      const result = await this.api.confirmExportOverwrite({ reservation_id });
      if (run === this.generation) this.started(reservation_id, result.task_id);
    } catch (reason) {
      if (
        run === this.generation &&
        reservation_of(this.state.flow) === reservation_id
      )
        this.finish({ kind: "error", message: message_of(reason) });
    }
  };

  private started(reservation_id: string, task_id: string): void {
    const flow = this.state.flow;
    if (reservation_of(flow) !== reservation_id) return;
    const running: RunningFlow = {
      phase: "started",
      task_id,
      progress: { stage: "preparing" },
      png_written: false,
    };
    if (flow.phase === "cancelling") {
      const target = { task_id };
      this.transition({ phase: "cancelling", target });
      void this.send_cancel(target, running);
    } else {
      this.transition(running, { live_message: "正在准备导出" });
    }
  }

  cancel_or_return = (): void => {
    const flow = this.state.flow;
    if (flow.phase === "editing") {
      this.finish(null);
    } else if (flow.phase === "started") {
      this.transition({ ...flow, phase: "cancel_confirm" });
    } else if (flow.phase === "cancel_confirm") {
      this.transition({ ...flow, phase: "started" });
    } else if (flow.phase === "preparing" && !flow.reservation_id) {
      this.transition(
        {
          phase: "cancelling",
          target: { reservation_id: null, reason: "cancelled" },
        },
        { live_message: "正在取消导出" },
      );
    } else {
      const reservation_id = reservation_of(flow);
      if (
        !reservation_id ||
        flow.phase === "cancelling" ||
        flow.phase === "handing_off"
      )
        return;
      const target = {
        reservation_id,
        reason:
          flow.phase === "confirming_overwrite"
            ? ("destination-returned" as const)
            : ("cancelled" as const),
      };
      this.transition(
        { phase: "cancelling", target },
        { live_message: "正在取消导出" },
      );
      void this.send_cancel(target, flow);
    }
  };

  confirm_cancel = (): void => {
    const flow = this.state.flow;
    if (flow.phase !== "cancel_confirm") return;
    const target = { task_id: flow.task_id };
    this.transition(
      { phase: "cancelling", target },
      { live_message: "正在取消导出" },
    );
    void this.send_cancel(target, { ...flow, phase: "started" });
  };

  private async send_cancel(
    target: Extract<ExportFlow, { phase: "cancelling" }>["target"],
    fallback: ExportFlow,
  ): Promise<void> {
    const run = this.generation;
    try {
      if ("reason" in target) {
        if (!target.reservation_id) return;
        await this.api.cancelExport({
          reservation_id: target.reservation_id,
          reason: target.reason,
        });
      } else await this.api.cancelExport(target);
    } catch (reason) {
      const flow = this.state.flow;
      if (
        run === this.generation &&
        flow.phase === "cancelling" &&
        flow.target === target
      )
        this.transition(fallback, {
          notice: { kind: "error", message: message_of(reason) },
          live_message: message_of(reason),
        });
    }
  }

  retry_cleanup = async (): Promise<void> => {
    const flow = this.state.flow;
    if (flow.phase !== "cleanup_blocked") return;
    const attempt = ++this.cleanup_attempt;
    const run = this.generation;
    this.transition(
      { ...flow, phase: "cleanup_retrying" },
      { live_message: "正在重试清理导出资源" },
    );
    try {
      await this.api.retryExportCleanup({ task_id: flow.task_id });
    } catch (reason) {
      const current = this.state.flow;
      if (
        run === this.generation &&
        attempt === this.cleanup_attempt &&
        current.phase === "cleanup_retrying" &&
        current.task_id === flow.task_id
      )
        this.transition(
          {
            ...current,
            phase: "cleanup_blocked",
            cleanup_error: message_of(reason),
          },
          { live_message: "导出资源清理仍然失败" },
        );
    }
  };

  exit_after_cleanup = async (): Promise<void> => {
    const flow = this.state.flow;
    if (flow.phase !== "cleanup_blocked") return;
    const run = this.generation;
    try {
      await this.api.exitAfterExportCleanup({ task_id: flow.task_id });
    } catch (reason) {
      const current = this.state.flow;
      if (
        run === this.generation &&
        current.phase === "cleanup_blocked" &&
        current.task_id === flow.task_id
      )
        this.transition({ ...current, cleanup_error: message_of(reason) });
    }
  };

  dismiss_notice = (expected = this.state.notice): void => {
    if (this.state.notice === expected) this.update({ notice: null });
  };

  open_directory = async (): Promise<void> => {
    const notice = this.state.notice;
    if (!notice?.task_id || !notice.saved?.length) return;
    try {
      await this.api.openExportDirectory({ task_id: notice.task_id });
    } catch (reason) {
      if (this.state.notice === notice)
        this.update({
          notice: { ...notice, kind: "error", message: message_of(reason) },
        });
    }
  };

  private on_event = (event: DesktopExportEvent): void => {
    const flow = this.state.flow;
    if ("reservation_id" in event) {
      if (event.reservation_id !== reservation_of(flow)) {
        // Buffer only while the preparation reply has not supplied its identity.
        if (
          ((flow.phase === "preparing" && !flow.reservation_id) ||
            (flow.phase === "cancelling" &&
              "reservation_id" in flow.target &&
              !flow.target.reservation_id)) &&
          (event.type === "preparation-ready" ||
            event.type === "preparation-cancelled" ||
            event.type === "preparation-failed")
        )
          this.early_events.set(event.reservation_id, event);
        return;
      }
      if (event.type === "preparation-ready") {
        if (flow.phase === "preparing")
          void this.choose_destination(event.reservation_id);
      } else if (event.type === "preparation-status") {
        this.update({
          live_message:
            flow.phase === "cancelling" || event.stage === "cancelling"
              ? "正在取消导出准备"
              : event.stage === "saving_fields"
                ? "正在保存展示字段"
                : event.stage === "building_snapshot"
                  ? "正在生成导出快照"
                  : "导出快照已准备完成",
        });
      } else if (event.type === "preparation-cancelled") {
        if (event.reason === "destination-returned") {
          this.generation += 1;
          this.early_events.clear();
          this.transition(
            { phase: "editing", editing_focus: "directory" },
            { live_message: "" },
          );
        } else this.finish({ kind: "cancelled", message: "已取消导出" });
      } else if (event.type === "preparation-failed") {
        this.finish({ kind: "error", message: event.message });
      } else if (event.type === "started") {
        this.started(event.reservation_id, event.task_id);
      }
      return;
    }
    if (event.task_id !== task_of(flow)) return;
    if (
      event.type === "progress" &&
      (flow.phase === "started" || flow.phase === "cancel_confirm")
    ) {
      this.transition(
        {
          ...flow,
          progress: event,
          png_written: flow.png_written || !!event.png_written,
        },
        {
          live_message:
            event.stage === "preparing"
              ? "正在准备导出"
              : event.stage === "rendering"
                ? event.completed !== undefined && event.total
                  ? `正在渲染第 ${event.completed} / ${event.total} 帧`
                  : "正在渲染素材"
                : event.format
                  ? `正在提交 ${event.format.toUpperCase()} 产物`
                  : "正在提交导出产物",
        },
      );
    } else if (
      event.type === "cancelling" &&
      (flow.phase === "started" || flow.phase === "cancel_confirm")
    ) {
      this.transition(
        { phase: "cancelling", target: { task_id: event.task_id } },
        { live_message: "正在取消导出" },
      );
    } else if (
      (event.type === "completed" ||
        event.type === "cancelled" ||
        event.type === "failed") &&
      (flow.phase === "started" ||
        flow.phase === "cancel_confirm" ||
        flow.phase === "cancelling")
    ) {
      if (event.cleanup_status === "blocked") {
        this.transition(
          {
            phase: "cleanup_blocked",
            task_id: event.task_id,
            terminal: event,
            cleanup_error: event.cleanup_message ?? "导出资源清理失败",
            residual_files: event.residual_files,
          },
          { live_message: "导出已结束，但资源清理失败" },
        );
      } else this.finish(notice_for_terminal(event));
    } else if (
      flow.phase === "cleanup_blocked" ||
      flow.phase === "cleanup_retrying"
    ) {
      if (event.type === "cleanup-retrying") {
        this.transition(
          { ...flow, phase: "cleanup_retrying" },
          { live_message: "正在重试清理导出资源" },
        );
      } else if (event.type === "cleanup-failed") {
        this.transition(
          {
            ...flow,
            phase: "cleanup_blocked",
            cleanup_error: event.message,
            residual_files: event.residual_files,
          },
          { live_message: "导出资源清理仍然失败" },
        );
      } else if (event.type === "cleanup-completed") {
        this.finish({
          ...notice_for_terminal(flow.terminal),
          message:
            flow.terminal.saved.length > 0
              ? "文件已保存，导出资源现已清理"
              : "导出失败，导出资源现已清理",
        });
      }
    }
  };
}
