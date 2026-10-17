import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import type { ExportContext } from "./export_workflow_controller";
import {
  ExportDialogContent,
  ExportNoticeView,
  type ExportDialogActions,
} from "./ExportDialogs";
import { use_export_workflow } from "./use_export_workflow";

type ExportWorkflowProps = {
  context: ExportContext;
  children: (controls: { active: boolean; open: () => void }) => ReactNode;
};

function use_focus_trap(
  dialog_ref: RefObject<HTMLDivElement | null>,
  active: boolean,
  focus_key: string,
  on_escape: () => void,
) {
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
        on_escape();
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
  }, [active, dialog_ref, focus_key, on_escape]);
}

export function ExportWorkflow({ context, children }: ExportWorkflowProps) {
  const { state, controller } = use_export_workflow();
  const trigger_ref = useRef<HTMLElement | null>(null);
  const dialog_ref = useRef<HTMLDivElement>(null);
  const { flow, notice, live_message } = state;
  const active = flow.phase !== "closed";

  useLayoutEffect(() => {
    if (!active) trigger_ref.current?.focus();
  }, [active]);

  const open = () => {
    const trigger = document.activeElement as HTMLElement | null;
    if (controller.open(context)) trigger_ref.current = trigger;
  };
  const actions: ExportDialogActions = {
    set_base_name: controller.set_base_name,
    toggle_format: controller.toggle_format,
    start_preparation: () => void controller.start_preparation(context),
    cancel_or_return: controller.cancel_or_return,
    confirm_overwrite: controller.confirm_overwrite,
    confirm_cancel: controller.confirm_cancel,
    retry_cleanup: controller.retry_cleanup,
    exit_after_cleanup: controller.exit_after_cleanup,
  };
  use_focus_trap(
    dialog_ref,
    active,
    `${flow.phase}:${flow.phase === "editing" ? flow.editing_focus : ""}`,
    controller.cancel_or_return,
  );

  return (
    <>
      <div className="export-background" inert={active ? true : undefined}>
        {children({ active, open })}
      </div>
      {notice && (
        <ExportNoticeView
          notice={notice}
          on_open_directory={controller.open_directory}
          on_dismiss={() => controller.dismiss_notice()}
        />
      )}
      {active && (
        <div className="export-overlay" data-phase={flow.phase}>
          <div
            aria-labelledby="export-dialog-title"
            aria-modal="true"
            className="export-dialog"
            ref={dialog_ref}
            role="dialog"
          >
            <ExportDialogContent state={state} actions={actions} />
            <div className="export-live" aria-live="polite" aria-atomic="true">
              {live_message}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
