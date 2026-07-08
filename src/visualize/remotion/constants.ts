import { ANIMATION_TOTAL_MS } from "../animation/timeline";
import { CANVAS_HEIGHT, CANVAS_WIDTH, VIDEO_FPS } from "../constants";

export const CDF_COMPOSITION_ID = "CdfVisualization";
export const CDF_VIDEO_WIDTH = CANVAS_WIDTH;
export const CDF_VIDEO_HEIGHT = CANVAS_HEIGHT;
export const CDF_VIDEO_FPS = VIDEO_FPS;
export const CDF_VIDEO_HOLD_MS = 200;
export const CDF_DURATION_IN_FRAMES = Math.ceil(
  ((ANIMATION_TOTAL_MS + CDF_VIDEO_HOLD_MS) / 1000) * CDF_VIDEO_FPS,
);
