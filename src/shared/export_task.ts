export const EXPORT_FORMATS = ["mp4", "png"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type ExportStage = "preparing" | "rendering" | "finalizing";
export type ExportPreparationStage =
  | "saving_fields"
  | "building_snapshot"
  | "awaiting_destination"
  | "cancelling";

export type ExportPreparationRequest = {
  session_id: string;
  formats: ExportFormat[];
  base_name: string;
};

export type ExportPreparationAccepted = { reservation_id: string };
export type ExportCancelRequest =
  | { reservation_id: string; task_id?: never }
  | { task_id: string; reservation_id?: never };

export type ExportArtifact = {
  format: ExportFormat;
  path: string;
};

export type ExportPreparationEvent =
  | {
      type: "preparation-status" | "preparation-heartbeat";
      reservation_id: string;
      stage: ExportPreparationStage;
    }
  | { type: "preparation-ready"; reservation_id: string }
  | { type: "preparation-cancelled"; reservation_id: string }
  | {
      type: "preparation-failed";
      reservation_id: string;
      message: string;
    };

export type ExportTaskEvent =
  | {
      type: "started";
      reservation_id: string;
      task_id: string;
      formats: ExportFormat[];
      base_name: string;
    }
  | {
      type: "progress";
      task_id: string;
      stage: ExportStage;
      completed?: number;
      total?: number;
      png_written?: boolean;
    }
  | { type: "heartbeat"; task_id: string; stage: ExportStage }
  | { type: "cancelling"; task_id: string }
  | { type: "completed"; task_id: string; saved: ExportArtifact[] }
  | { type: "cancelled"; task_id: string; saved: ExportArtifact[] }
  | {
      type: "failed";
      task_id: string;
      message: string;
      saved: ExportArtifact[];
      failed: ExportFormat[];
      residual_paths: string[];
    };

export type DesktopExportEvent = ExportPreparationEvent | ExportTaskEvent;

function object_value(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export function validate_export_formats(value: unknown): ExportFormat[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2)
    throw new Error("at least one export format is required");
  const formats: ExportFormat[] = [];
  for (const format of value) {
    if (format !== "mp4" && format !== "png")
      throw new Error("invalid export format");
    if (formats.includes(format)) throw new Error("duplicate export format");
    formats.push(format);
  }
  return formats;
}

export function validate_export_preparation_request(
  value: unknown,
): ExportPreparationRequest {
  const request = object_value(value, "export preparation request");
  const keys = Object.keys(request);
  if (
    keys.length !== 3 ||
    keys.some((key) => !["session_id", "formats", "base_name"].includes(key))
  )
    throw new Error("export preparation request contains unsupported fields");
  if (typeof request.session_id !== "string" || !request.session_id)
    throw new Error("invalid result session id");
  if (
    typeof request.base_name !== "string" ||
    !request.base_name ||
    request.base_name === "." ||
    request.base_name === ".." ||
    [...request.base_name].some((character) => character.charCodeAt(0) < 32) ||
    /[<>:"/\\|?*]/.test(request.base_name) ||
    /[ .]$/.test(request.base_name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(request.base_name)
  )
    throw new Error("invalid export base name");
  return {
    session_id: request.session_id,
    formats: validate_export_formats(request.formats),
    base_name: request.base_name,
  };
}

export function validate_export_cancel_request(
  value: unknown,
): ExportCancelRequest {
  const request = object_value(value, "export cancel request");
  const keys = Object.keys(request);
  if (keys.length !== 1) throw new Error("invalid export cancel request");
  if (typeof request.reservation_id === "string" && request.reservation_id)
    return { reservation_id: request.reservation_id };
  if (typeof request.task_id === "string" && request.task_id)
    return { task_id: request.task_id };
  throw new Error("invalid export cancel request");
}
