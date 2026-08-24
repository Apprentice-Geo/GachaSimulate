import type { CSSProperties } from "react";
import { ANIMATION_TIMELINE } from "./timeline";

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
  marker_group: (index: number) => FadeProgress;
  stat_content: (index: number) => MetricProgress;
}

function clamp_progress(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function segment_progress(
  elapsed_ms: number,
  delay_ms: number,
  duration_ms: number,
): number {
  return clamp_progress((elapsed_ms - delay_ms) / duration_ms);
}

export type Easing = (progress: number) => number;

export function linear(progress: number): number {
  return progress;
}

export function ease_out_quad(progress: number): number {
  return 1 - Math.pow(1 - progress, 2);
}

export function ease_out_cubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3);
}

function fade_progress(
  elapsed_ms: number,
  delay_ms: number,
  duration_ms: number,
  distance_px: number,
  easing: Easing,
): FadeProgress {
  const progress = easing(segment_progress(elapsed_ms, delay_ms, duration_ms));
  return {
    opacity: progress,
    translate_y: distance_px * (1 - progress),
  };
}

function metric_progress(elapsed_ms: number, index: number): MetricProgress {
  return timed_metric_progress(
    elapsed_ms,
    ANIMATION_TIMELINE.STAT_CONTENT_DELAY_MS +
      index * ANIMATION_TIMELINE.STAT_CONTENT_STAGGER_MS,
    ANIMATION_TIMELINE.STAT_CONTENT_DURATION_MS,
    32,
    ease_out_cubic,
  );
}

function timed_metric_progress(
  elapsed_ms: number,
  delay_ms: number,
  duration_ms: number,
  distance_px: number,
  easing: Easing,
): MetricProgress {
  const progress = easing(segment_progress(elapsed_ms, delay_ms, duration_ms));
  return {
    opacity: progress,
    translate_x: distance_px * (1 - progress),
  };
}

function scale_progress(
  elapsed_ms: number,
  delay_ms: number,
  duration_ms: number,
  start_scale: number,
  target_opacity: number,
  easing: Easing,
): ScaleProgress {
  const progress = easing(segment_progress(elapsed_ms, delay_ms, duration_ms));
  return {
    opacity: target_opacity * progress,
    scale: start_scale + (1 - start_scale) * progress,
  };
}

export function build_animation_progress(
  elapsed_ms: number,
): AnimationProgress {
  return {
    title_area: (index) =>
      timed_metric_progress(
        elapsed_ms,
        ANIMATION_TIMELINE.TITLE_AREA_DELAY_MS +
          index * ANIMATION_TIMELINE.TITLE_AREA_STAGGER_MS,
        ANIMATION_TIMELINE.TITLE_AREA_DURATION_MS,
        32,
        ease_out_cubic,
      ),
    metadata: (index) =>
      timed_metric_progress(
        elapsed_ms,
        ANIMATION_TIMELINE.METADATA_DELAY_MS +
          index * ANIMATION_TIMELINE.METADATA_STAGGER_MS,
        ANIMATION_TIMELINE.METADATA_DURATION_MS,
        32,
        ease_out_cubic,
      ),
    chart_shell: fade_progress(
      elapsed_ms,
      ANIMATION_TIMELINE.CHART_SHELL_DELAY_MS,
      ANIMATION_TIMELINE.CHART_SHELL_DURATION_MS,
      12,
      ease_out_cubic,
    ),
    chart_surface: fade_progress(
      elapsed_ms,
      ANIMATION_TIMELINE.CHART_SURFACE_DELAY_MS,
      ANIMATION_TIMELINE.CHART_SURFACE_DURATION_MS,
      12,
      ease_out_cubic,
    ),
    curve: ease_out_cubic(
      segment_progress(
        elapsed_ms,
        ANIMATION_TIMELINE.CURVE_DELAY_MS,
        ANIMATION_TIMELINE.CURVE_DURATION_MS,
      ),
    ),
    mean_line: scale_progress(
      elapsed_ms,
      ANIMATION_TIMELINE.MEAN_LINE_DELAY_MS,
      ANIMATION_TIMELINE.MEAN_LINE_DURATION_MS,
      0.35,
      0.85,
      ease_out_cubic,
    ),
    termination_surface: fade_progress(
      elapsed_ms,
      ANIMATION_TIMELINE.TERMINATION_PANEL_DELAY_MS,
      ANIMATION_TIMELINE.TERMINATION_PANEL_DURATION_MS,
      16,
      ease_out_cubic,
    ),
    termination_title: fade_progress(
      elapsed_ms,
      ANIMATION_TIMELINE.TERMINATION_PANEL_DELAY_MS,
      ANIMATION_TIMELINE.TERMINATION_PANEL_DURATION_MS,
      16,
      ease_out_cubic,
    ),
    pk_fill: ease_out_cubic(
      segment_progress(
        elapsed_ms,
        ANIMATION_TIMELINE.PK_FILL_DELAY_MS,
        ANIMATION_TIMELINE.PK_FILL_DURATION_MS,
      ),
    ),
    termination_detail: fade_progress(
      elapsed_ms,
      ANIMATION_TIMELINE.TERMINATION_DETAIL_DELAY_MS,
      ANIMATION_TIMELINE.TERMINATION_DETAIL_DURATION_MS,
      12,
      ease_out_cubic,
    ),
    stat_surface: fade_progress(
      elapsed_ms,
      ANIMATION_TIMELINE.STAT_PANEL_DELAY_MS,
      ANIMATION_TIMELINE.STAT_PANEL_DURATION_MS,
      12,
      ease_out_cubic,
    ),
    note: fade_progress(
      elapsed_ms,
      ANIMATION_TIMELINE.NOTE_DELAY_MS,
      ANIMATION_TIMELINE.NOTE_DURATION_MS,
      12,
      ease_out_cubic,
    ),
    marker_line: (index) =>
      scale_progress(
        elapsed_ms,
        ANIMATION_TIMELINE.MARKER_LINE_DELAY_MS +
          index * ANIMATION_TIMELINE.MARKER_STAGGER_MS,
        ANIMATION_TIMELINE.MARKER_LINE_DURATION_MS,
        0.35,
        1,
        ease_out_cubic,
      ),
    marker_group: (index) =>
      fade_progress(
        elapsed_ms,
        ANIMATION_TIMELINE.MARKER_GROUP_DELAY_MS +
          index * ANIMATION_TIMELINE.MARKER_STAGGER_MS,
        ANIMATION_TIMELINE.MARKER_GROUP_DURATION_MS,
        6,
        ease_out_cubic,
      ),
    stat_content: (index) => metric_progress(elapsed_ms, index),
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
