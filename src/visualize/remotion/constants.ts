import { ANIMATION_TOTAL_MS } from "../animation/timeline";

export const CDF_COMPOSITION_ID = "CdfVisualization";
export const CDF_VIDEO_WIDTH = 3840;
export const CDF_VIDEO_HEIGHT = 2160;
export const CDF_VIDEO_FPS = 60;
export const CDF_VIDEO_HOLD_MS = 200;
export const CDF_DURATION_IN_FRAMES = Math.ceil(
  ((ANIMATION_TOTAL_MS + CDF_VIDEO_HOLD_MS) / 1000) * CDF_VIDEO_FPS,
);
