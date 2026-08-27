import type { CDFViewModel } from "../visualize/types/cdf";
import { EXPORT_FRAME_COUNT } from "../visualize/animation/export_frame";

export const EXPORT_RENDERER_CHANNELS = {
  initialize: "export-renderer:initialize",
  render_frame: "export-renderer:render-frame",
  initialized: "export-renderer:initialized",
  frame_ready: "export-renderer:frame-ready",
  renderer_failed: "export-renderer:renderer-failed",
} as const;

export interface ExportRendererInitializeMessage {
  job_id: string;
  view_model: CDFViewModel;
}

export interface ExportRendererFrameMessage {
  job_id: string;
  frame: number;
}

export interface ExportRendererInitializedMessage {
  job_id: string;
}

export interface ExportRendererFailedMessage {
  job_id: string;
  message: string;
}

export interface ExportRendererApi {
  onInitialize(
    listener: (message: ExportRendererInitializeMessage) => void,
  ): () => void;
  onRenderFrame(
    listener: (message: ExportRendererFrameMessage) => void,
  ): () => void;
  initialized(message: ExportRendererInitializedMessage): void;
  frameReady(message: ExportRendererFrameMessage): void;
  rendererFailed(message: ExportRendererFailedMessage): void;
}

export function is_export_job_id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function is_export_frame(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) < EXPORT_FRAME_COUNT
  );
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_string(value: unknown): value is string {
  return typeof value === "string";
}

function is_finite_number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function is_cdf_view_model(value: unknown): value is CDFViewModel {
  if (!is_record(value) || !is_record(value.result_item)) return false;
  const string_fields = [
    "title",
    "target",
    "total_result_display",
    "result_item_unit",
    "axis_title",
    "subtitle",
    "note",
  ] as const;
  if (string_fields.some((field) => !is_string(value[field]))) return false;
  if (
    !is_string(value.result_item.id) ||
    !is_string(value.result_item.name) ||
    !is_finite_number(value.total_result) ||
    !is_finite_number(value.runs) ||
    !is_finite_number(value.x_domain_max) ||
    !Array.isArray(value.chart_points) ||
    !value.chart_points.every(
      (point) =>
        is_record(point) &&
        is_finite_number(point.draw) &&
        is_finite_number(point.cumulative),
    ) ||
    !Array.isArray(value.termination_reason) ||
    !value.termination_reason.every(
      (reason) =>
        is_record(reason) &&
        is_string(reason.reason) &&
        is_finite_number(reason.proportion),
    ) ||
    !Array.isArray(value.metrics) ||
    !value.metrics.every(
      (metric) =>
        is_record(metric) &&
        is_string(metric.key) &&
        is_string(metric.label) &&
        is_finite_number(metric.value) &&
        is_string(metric.display_value) &&
        is_string(metric.color),
    ) ||
    !Array.isArray(value.markers) ||
    !value.markers.every(
      (marker) =>
        is_record(marker) &&
        is_string(marker.key) &&
        is_string(marker.label) &&
        is_finite_number(marker.draw) &&
        is_finite_number(marker.level) &&
        is_string(marker.color) &&
        is_string(marker.weight),
    )
  ) {
    return false;
  }
  return true;
}

export function is_export_initialize_message(
  value: unknown,
): value is ExportRendererInitializeMessage {
  return (
    is_record(value) &&
    is_export_job_id(value.job_id) &&
    is_cdf_view_model(value.view_model)
  );
}

export function is_export_frame_message(
  value: unknown,
): value is ExportRendererFrameMessage {
  return (
    is_record(value) &&
    is_export_job_id(value.job_id) &&
    is_export_frame(value.frame)
  );
}

export function is_export_initialized_message(
  value: unknown,
): value is ExportRendererInitializedMessage {
  return is_record(value) && is_export_job_id(value.job_id);
}

export function is_export_failed_message(
  value: unknown,
): value is ExportRendererFailedMessage {
  return (
    is_record(value) &&
    is_export_job_id(value.job_id) &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 4_096
  );
}

declare global {
  interface Window {
    exportRendererApi: ExportRendererApi;
  }
}
