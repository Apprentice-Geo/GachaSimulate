import type { CSSProperties } from "react";
import { VIDEO_FPS } from "../constants";
import type { MarkerKey } from "../types/cdf";
import {
  ANIMATION_COMPLETION_FRAME,
  ANIMATION_TIMELINE,
  MARKER_GROUP_START_FRAME,
} from "./timeline";

export interface FadeProgress {
  opacity: number;
  translate_y: number;
}

export interface MetricProgress {
  opacity: number;
  translate_x: number;
}

export interface ScaleProgress {
  opacity: number;
  scale: number;
}

export interface AnimationProgress {
  title_area: (index: number) => MetricProgress;
  metadata: (index: number) => MetricProgress;
  chart_shell: FadeProgress;
  chart_surface: FadeProgress;
  curve: number;
  mean_line: ScaleProgress;
  termination_surface: FadeProgress;
  termination_title: FadeProgress;
  pk_fill: number;
  termination_detail: FadeProgress;
  stat_surface: FadeProgress;
  note: FadeProgress;
  marker_line: (index: number) => ScaleProgress;
  marker_group: (key: MarkerKey) => FadeProgress;
  stat_content: (index: number) => MetricProgress;
}

export type Easing = (progress: number) => number;

const MARKER_SEMANTIC_ORDER: readonly MarkerKey[] = [
  "MIN",
  "P5",
  "P25",
  "P50",
  "MEAN",
  "P75",
  "P95",
  "MAX",
];

function clamp_progress(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function linear(progress: number): number {
  return progress;
}

export function ease_out_quad(progress: number): number {
  return 1 - Math.pow(1 - progress, 2);
}

export function ease_out_cubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3);
}

export function segment_progress(
  frame_progress: number,
  start_frame: number,
  completion_frame: number,
  easing: Easing,
): number {
  return easing(
    clamp_progress(
      (frame_progress - start_frame) / (completion_frame - start_frame),
    ),
  );
}

export function build_marker_line_order(
  markers: readonly { key: MarkerKey; position: number }[],
): MarkerKey[] {
  return [...markers]
    .sort((left, right) => {
      const position_order = left.position - right.position;
      if (position_order !== 0) {
        return position_order;
      }
      return (
        MARKER_SEMANTIC_ORDER.indexOf(left.key) -
        MARKER_SEMANTIC_ORDER.indexOf(right.key)
      );
    })
    .map(({ key }) => key);
}

function fade_progress(
  frame_progress: number,
  start_frame: number,
  completion_frame: number,
  distance_px: number,
  easing: Easing,
): FadeProgress {
  const progress = segment_progress(
    frame_progress,
    start_frame,
    completion_frame,
    easing,
  );
  return {
    opacity: progress,
    translate_y: distance_px * (1 - progress),
  };
}

function timed_metric_progress(
  frame_progress: number,
  start_frame: number,
  completion_frame: number,
  distance_px: number,
  easing: Easing,
): MetricProgress {
  const progress = segment_progress(
    frame_progress,
    start_frame,
    completion_frame,
    easing,
  );
  return {
    opacity: progress,
    translate_x: distance_px * (1 - progress),
  };
}

function scale_progress(
  frame_progress: number,
  start_frame: number,
  completion_frame: number,
  start_scale: number,
  target_opacity: number,
  easing: Easing,
): ScaleProgress {
  const progress = segment_progress(
    frame_progress,
    start_frame,
    completion_frame,
    easing,
  );
  return {
    opacity: target_opacity * progress,
    scale: start_scale + (1 - start_scale) * progress,
  };
}

export function build_animation_progress(
  elapsed_ms: number,
): AnimationProgress {
  const frame_progress = Math.min(
    ANIMATION_COMPLETION_FRAME,
    (elapsed_ms / 1000) * VIDEO_FPS,
  );

  return {
    title_area: (index) => {
      const start_frame =
        ANIMATION_TIMELINE.TITLE_AREA.start_frame +
        index * ANIMATION_TIMELINE.TITLE_AREA.stagger_frames;
      return timed_metric_progress(
        frame_progress,
        start_frame,
        ANIMATION_TIMELINE.TITLE_AREA.completion_frame +
          index * ANIMATION_TIMELINE.TITLE_AREA.stagger_frames,
        32,
        ease_out_cubic,
      );
    },
    metadata: (index) => {
      const start_frame =
        ANIMATION_TIMELINE.METADATA.start_frame +
        index * ANIMATION_TIMELINE.METADATA.stagger_frames;
      return timed_metric_progress(
        frame_progress,
        start_frame,
        ANIMATION_TIMELINE.METADATA.completion_frame +
          index * ANIMATION_TIMELINE.METADATA.stagger_frames,
        32,
        ease_out_cubic,
      );
    },
    chart_shell: fade_progress(
      frame_progress,
      ANIMATION_TIMELINE.CHART_SHELL.start_frame,
      ANIMATION_TIMELINE.CHART_SHELL.completion_frame,
      12,
      ease_out_quad,
    ),
    chart_surface: fade_progress(
      frame_progress,
      ANIMATION_TIMELINE.CHART_SURFACE.start_frame,
      ANIMATION_TIMELINE.CHART_SURFACE.completion_frame,
      12,
      ease_out_quad,
    ),
    curve: segment_progress(
      frame_progress,
      ANIMATION_TIMELINE.CURVE.start_frame,
      ANIMATION_TIMELINE.CURVE.completion_frame,
      linear,
    ),
    mean_line: scale_progress(
      frame_progress,
      ANIMATION_TIMELINE.MEAN_LINE.start_frame,
      ANIMATION_TIMELINE.MEAN_LINE.completion_frame,
      0.35,
      0.85,
      ease_out_quad,
    ),
    termination_surface: fade_progress(
      frame_progress,
      ANIMATION_TIMELINE.TERMINATION_SURFACE.start_frame,
      ANIMATION_TIMELINE.TERMINATION_SURFACE.completion_frame,
      16,
      ease_out_quad,
    ),
    termination_title: fade_progress(
      frame_progress,
      ANIMATION_TIMELINE.TERMINATION_TITLE.start_frame,
      ANIMATION_TIMELINE.TERMINATION_TITLE.completion_frame,
      16,
      ease_out_quad,
    ),
    pk_fill: segment_progress(
      frame_progress,
      ANIMATION_TIMELINE.PK_FILL.start_frame,
      ANIMATION_TIMELINE.PK_FILL.completion_frame,
      ease_out_quad,
    ),
    termination_detail: fade_progress(
      frame_progress,
      ANIMATION_TIMELINE.TERMINATION_DETAIL.start_frame,
      ANIMATION_TIMELINE.TERMINATION_DETAIL.completion_frame,
      12,
      ease_out_quad,
    ),
    stat_surface: fade_progress(
      frame_progress,
      ANIMATION_TIMELINE.STAT_SURFACE.start_frame,
      ANIMATION_TIMELINE.STAT_SURFACE.completion_frame,
      12,
      ease_out_quad,
    ),
    note: fade_progress(
      frame_progress,
      ANIMATION_TIMELINE.NOTE.start_frame,
      ANIMATION_TIMELINE.NOTE.completion_frame,
      12,
      ease_out_quad,
    ),
    marker_line: (index) =>
      scale_progress(
        frame_progress,
        ANIMATION_TIMELINE.MARKER_LINE.start_frame +
          index * ANIMATION_TIMELINE.MARKER_LINE.stagger_frames,
        ANIMATION_TIMELINE.MARKER_LINE.completion_frame +
          index * ANIMATION_TIMELINE.MARKER_LINE.stagger_frames,
        0.35,
        1,
        ease_out_quad,
      ),
    marker_group: (key) =>
      fade_progress(
        frame_progress,
        MARKER_GROUP_START_FRAME[key],
        MARKER_GROUP_START_FRAME[key] +
          ANIMATION_TIMELINE.MARKER_GROUP_DURATION_FRAMES,
        6,
        ease_out_quad,
      ),
    stat_content: (index) =>
      timed_metric_progress(
        frame_progress,
        ANIMATION_TIMELINE.STAT_CONTENT.start_frame +
          index * ANIMATION_TIMELINE.STAT_CONTENT.stagger_frames,
        ANIMATION_TIMELINE.STAT_CONTENT.completion_frame +
          index * ANIMATION_TIMELINE.STAT_CONTENT.stagger_frames,
        32,
        ease_out_quad,
      ),
  };
}

export function fade_style(progress: FadeProgress): CSSProperties {
  return {
    opacity: progress.opacity,
    transform: `translateY(${progress.translate_y}px)`,
  };
}

export function metric_style(progress: MetricProgress): CSSProperties {
  return {
    opacity: progress.opacity,
    transform: `translateX(${progress.translate_x}px)`,
  };
}
