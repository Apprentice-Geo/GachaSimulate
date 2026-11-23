import { VIDEO_FPS } from "../constants";
import { CDF_PLOT_SIZE } from "../view/scene_layout";
import { CDF_MARKER_VIEW_CONFIG } from "../view/cdf_view_config";
import type { CDFViewModel, MarkerKey } from "../types/cdf";

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
  CURVE_AREA: { start_frame: 48, completion_frame: 54 },
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
    completion_frame: 43,
    stagger_frames: 2,
  },
  MEAN_LINE: { start_frame: 39, completion_frame: 55 },
  MARKER_GROUP_DURATION_FRAMES: 9,
  NOTE: { start_frame: 44, completion_frame: 57 },
} as const;

export type QuantileFrames = Record<"P50" | "P95", number>;

export function quantile_reveal_frames({
  chart_points,
  x_domain_max,
}: Pick<CDFViewModel, "chart_points" | "x_domain_max">): QuantileFrames {
  const first = chart_points[0];
  const last = chart_points[chart_points.length - 1];
  const x_distance = (draw: number) =>
    ((draw - first.draw) / x_domain_max) * CDF_PLOT_SIZE.width;
  // The length of a monotone staircase equals horizontal plus vertical travel.
  const length =
    x_distance(last.draw) +
    (last.cumulative - first.cumulative) * CDF_PLOT_SIZE.height;
  const { start_frame, completion_frame } = ANIMATION_TIMELINE.CURVE;
  function crossing(level: number) {
    let low = 0;
    let high = chart_points.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (chart_points[mid].cumulative < level) low = mid + 1;
      else high = mid;
    }
    const distance =
      x_distance(chart_points[low].draw) +
      Math.max(0, level - first.cumulative) * CDF_PLOT_SIZE.height;
    return {
      step: low,
      frame:
        start_frame +
        (length ? distance / length : 0) * (completion_frame - start_frame),
    };
  }
  const median = crossing(CDF_MARKER_VIEW_CONFIG.P50.quantile_level!);
  const upper = crossing(CDF_MARKER_VIEW_CONFIG.P95.quantile_level!);
  return {
    P50: median.step === upper.step ? upper.frame : median.frame,
    P95: upper.frame,
  };
}

export const MARKER_GROUP_START_FRAME: Readonly<
  Record<Exclude<MarkerKey, keyof QuantileFrames>, number>
> = {
  MEAN: 42,
  P25: 44,
  P75: 44,
  P5: 46,
  MIN: 48,
  MAX: 48,
};
