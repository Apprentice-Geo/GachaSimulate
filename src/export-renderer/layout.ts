import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../visualize/constants";

interface ExportCanvasLike {
  getBoundingClientRect(): { width: number; height: number };
}

interface ExportDocumentLike {
  fonts: { ready: Promise<unknown> };
  querySelector(selector: string): ExportCanvasLike | null;
}

export type ScheduleAnimationFrame = () => Promise<void>;

export function next_animation_frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function wait_for_export_layout(
  export_document: ExportDocumentLike,
  schedule_animation_frame: ScheduleAnimationFrame = next_animation_frame,
): Promise<void> {
  await export_document.fonts.ready;
  await schedule_animation_frame();

  const canvas = export_document.querySelector(
    '[data-testid="visualize-root"]',
  );
  if (!canvas) throw new Error("Export canvas was not mounted");
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width !== CANVAS_WIDTH || bounds.height !== CANVAS_HEIGHT) {
    throw new Error(
      `Export canvas must be ${CANVAS_WIDTH}x${CANVAS_HEIGHT}, got ${bounds.width}x${bounds.height}`,
    );
  }
}
