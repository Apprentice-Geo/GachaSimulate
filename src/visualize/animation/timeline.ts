import { VIDEO_FPS } from "../constants";
import type { MarkerKey } from "../types/cdf";

export const ANIMATION_COMPLETION_FRAME = 57;
export const ANIMATION_TOTAL_MS =
  (ANIMATION_COMPLETION_FRAME / VIDEO_FPS) * 1000;

export const ANIMATION_TIMELINE = {
  CHART_SHELL: { start_frame: 0, completion_frame: 10 },
  TITLE_AREA: {
    start_frame: 0,
    completion_frame: 12,
    stagger_frames: 2,
  },
  CHART_SURFACE: { start_frame: 10, completion_frame: 16 },
  CURVE: { start_frame: 16, completion_frame: 48 },
  METADATA: {
    start_frame: 24,
    completion_frame: 40,
    stagger_frames: 2,
  },
  STAT_SURFACE: { start_frame: 28, completion_frame: 44 },
  STAT_CONTENT: {
    start_frame: 28,
    completion_frame: 42,
    stagger_frames: 1,
  },
  TERMINATION_SURFACE: { start_frame: 32, completion_frame: 48 },
  TERMINATION_TITLE: { start_frame: 32, completion_frame: 46 },
  PK_FILL: { start_frame: 32, completion_frame: 55 },
  TERMINATION_DETAIL: { start_frame: 38, completion_frame: 55 },
  MARKER_LINE: {
    start_frame: 34,
    completion_frame: 50,
    stagger_frames: 1,
  },
  MEAN_LINE: { start_frame: 39, completion_frame: 55 },
  MARKER_GROUP_DURATION_FRAMES: 12,
  NOTE: { start_frame: 44, completion_frame: 57 },
} as const;

export const MARKER_GROUP_START_FRAME: Readonly<Record<MarkerKey, number>> = {
  P50: 42,
  MEAN: 42,
  P25: 43,
  P75: 43,
  P5: 44,
  P95: 44,
  MIN: 45,
  MAX: 45,
};
