import {
  is_export_frame_message,
  is_export_initialize_message,
  type ExportRendererFailedMessage,
  type ExportRendererFrameMessage,
  type ExportRendererInitializeMessage,
} from "../shared/export_renderer";

export interface ExportFrameToken extends ExportRendererFrameMessage {
  sequence: number;
}

type InitializeResult =
  | { ok: true; message: ExportRendererInitializeMessage }
  | { ok: false; failure: ExportRendererFailedMessage };

type FrameResult =
  | { ok: true; token: ExportFrameToken }
  | { ok: false; failure: ExportRendererFailedMessage };

type Phase = "awaiting-initialize" | "initializing" | "ready" | "failed";

function reason_message(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return (message.trim() || "Export renderer failed").slice(0, 4_096);
}

export class ExportRendererCoordinator {
  private phase: Phase = "awaiting-initialize";
  private job_id: string | null = null;
  private pending: ExportFrameToken | null = null;
  private sequence = 0;
  private readonly completed_frames = new Set<number>();

  acceptInitialize(value: unknown): InitializeResult {
    if (!is_export_initialize_message(value)) {
      return {
        ok: false,
        failure: this.fail(value, "Invalid initialize message"),
      };
    }
    if (this.phase !== "awaiting-initialize") {
      return {
        ok: false,
        failure: this.fail(value, "Export renderer was already initialized"),
      };
    }
    this.job_id = value.job_id;
    this.phase = "initializing";
    return { ok: true, message: value };
  }

  completeInitialization(job_id: string): boolean {
    if (this.phase !== "initializing" || this.job_id !== job_id) return false;
    this.phase = "ready";
    return true;
  }

  acceptFrame(value: unknown): FrameResult {
    if (!is_export_frame_message(value)) {
      return {
        ok: false,
        failure: this.fail(value, "Invalid render-frame message"),
      };
    }
    if (this.phase !== "ready") {
      return {
        ok: false,
        failure: this.fail(value, "Export renderer is not ready"),
      };
    }
    if (value.job_id !== this.job_id) {
      return {
        ok: false,
        failure: this.fail(value, "render-frame job id does not match"),
      };
    }
    if (this.pending || this.completed_frames.has(value.frame)) {
      return {
        ok: false,
        failure: this.fail(value, "Duplicate or overlapping render-frame"),
      };
    }
    const token = { ...value, sequence: ++this.sequence };
    this.pending = token;
    return { ok: true, token };
  }

  completeFrame(token: ExportFrameToken): boolean {
    if (
      this.phase !== "ready" ||
      !this.pending ||
      this.pending.sequence !== token.sequence ||
      this.pending.job_id !== token.job_id ||
      this.pending.frame !== token.frame
    ) {
      return false;
    }
    this.pending = null;
    this.completed_frames.add(token.frame);
    return true;
  }

  fail(value: unknown, reason: unknown): ExportRendererFailedMessage {
    const candidate =
      typeof value === "object" && value !== null && "job_id" in value
        ? (value as { job_id?: unknown }).job_id
        : null;
    const failure = {
      job_id:
        this.job_id ??
        (typeof candidate === "string" && candidate.length > 0
          ? candidate.slice(0, 128)
          : "unknown-export-job"),
      message: reason_message(reason),
    };
    this.phase = "failed";
    this.pending = null;
    return failure;
  }
}
