import { useEffect, useState, useSyncExternalStore } from "react";
import { ExportWorkflowController } from "./export_workflow_controller";

export function use_export_workflow() {
  const [controller] = useState(
    () => new ExportWorkflowController(window.desktopApi),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.get_snapshot,
  );
  useEffect(controller.connect, [controller]);
  useEffect(() => {
    const notice = state.notice;
    if (notice?.kind !== "cancelled") return;
    const timer = window.setTimeout(
      () => controller.dismiss_notice(notice),
      4_000,
    );
    return () => window.clearTimeout(timer);
  }, [controller, state.notice]);
  return { state, controller };
}
