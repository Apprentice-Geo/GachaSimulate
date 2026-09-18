import { VIDEO_FPS } from "../constants";
import { ANIMATION_COMPLETION_FRAME } from "./timeline";

export const EXPORT_FRAME_COUNT = 60;

export interface ExportFrameState {
  animation_state: "playing" | "idle";
  elapsed_ms: number;
  is_animating: boolean;
}

export function resolve_export_frame_state(frame: number): ExportFrameState {
  if (!Number.isInteger(frame) || frame < 0 || frame >= EXPORT_FRAME_COUNT) {
    throw new RangeError(
      `Export frame must be an integer from 0 through ${EXPORT_FRAME_COUNT - 1}`,
    );
  }

  const is_animating = frame < ANIMATION_COMPLETION_FRAME;
  return {
    animation_state: is_animating ? "playing" : "idle",
    elapsed_ms:
      (Math.min(frame, ANIMATION_COMPLETION_FRAME) / VIDEO_FPS) * 1000,
    is_animating,
  };
}
