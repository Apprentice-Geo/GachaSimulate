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
  | {
      reservation_id: string;
      reason: "cancelled" | "destination-returned";
      task_id?: never;
    }
  | { task_id: string; reservation_id?: never };

export type ExportDestinationRequest = { reservation_id: string };
export type ExportDestinationSelection =
  | { status: "returned" }
  | { status: "overwrite-required"; files: string[] }
  | { status: "started"; task_id: string };
export type ExportOverwriteConfirmation = {
  status: "started";
  task_id: string;
};

export type ExportArtifact = {
  format: ExportFormat;
  file_name: string;
};

export type ExportCleanupStatus = "clean" | "blocked";
export type ExportTaskRequest = { task_id: string };

type ExportTerminalDetails = {
  task_id: string;
  saved: ExportArtifact[];
  failed: ExportFormat[];
  cleanup_status: ExportCleanupStatus;
  residual_files: string[];
  cleanup_message?: string;
};

export type ExportPreparationEvent =
  | {
      type: "preparation-status";
      reservation_id: string;
      stage: ExportPreparationStage;
    }
  | { type: "preparation-ready"; reservation_id: string }
  | {
      type: "preparation-cancelled";
      reservation_id: string;
      reason: "cancelled" | "destination-returned";
    }
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
      format?: ExportFormat;
      committed?: number;
      artifact_total?: number;
    }
  | { type: "cancelling"; task_id: string }
  | ({ type: "completed" } & ExportTerminalDetails)
  | ({ type: "cancelled" } & ExportTerminalDetails)
  | ({
      type: "failed";
      message: string;
    } & ExportTerminalDetails)
  | {
      type: "cleanup-retrying";
      task_id: string;
    }
  | {
      type: "cleanup-failed";
      task_id: string;
      message: string;
      residual_files: string[];
    }
  | {
      type: "cleanup-completed";
      task_id: string;
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
  return {
    session_id: request.session_id,
    formats: validate_export_formats(request.formats),
    base_name: validate_export_base_name(request.base_name),
  };
}

export function validate_export_base_name(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 251 ||
    value === "." ||
    value === ".." ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    /[<>:"/\\|?*]/.test(value) ||
    /[ .]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  )
    throw new Error("invalid export base name");
  return value;
}

export function validate_export_cancel_request(
  value: unknown,
): ExportCancelRequest {
  const request = object_value(value, "export cancel request");
  const keys = Object.keys(request);
  if (
    keys.length === 2 &&
    typeof request.reservation_id === "string" &&
    request.reservation_id &&
    (request.reason === "cancelled" ||
      request.reason === "destination-returned")
  )
    return { reservation_id: request.reservation_id, reason: request.reason };
  if (
    keys.length === 1 &&
    typeof request.task_id === "string" &&
    request.task_id
  )
    return { task_id: request.task_id };
  throw new Error("invalid export cancel request");
}

export function validate_export_destination_request(
  value: unknown,
): ExportDestinationRequest {
  const request = object_value(value, "export destination request");
  if (
    Object.keys(request).length !== 1 ||
    typeof request.reservation_id !== "string" ||
    !request.reservation_id
  )
    throw new Error("invalid export destination request");
  return { reservation_id: request.reservation_id };
}

export function validate_export_task_request(
  value: unknown,
): ExportTaskRequest {
  const request = object_value(value, "export task request");
  if (
    Object.keys(request).length !== 1 ||
    typeof request.task_id !== "string" ||
    !request.task_id
  )
    throw new Error("invalid export task request");
  return { task_id: request.task_id };
}
