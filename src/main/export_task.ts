import { randomUUID } from "node:crypto";
import * as node_files from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  type DesktopExportEvent,
  type ExportCancelRequest,
  type ExportDestinationSelection,
  type ExportFormat,
  type ExportOverwriteConfirmation,
  type ExportPreparationAccepted,
  type ExportPreparationRequest,
  type ExportPreparationStage,
  type ExportStage,
  validate_export_cancel_request,
  validate_export_destination_request,
  validate_export_preparation_request,
} from "../shared/export_task";
import {
  ExportCancelledError,
  ExportHost,
  inspect_target_identity,
  target_identity_equal,
} from "./export_host";
import type {
  ExportFiles,
  ExportHostProgress,
  ExportHostRequest,
  SavedExportArtifact,
  TargetIdentity,
} from "./export_host";
import type { ResultEditor, ResultSnapshot } from "./result_editor";
import { UserRequestAdmission } from "./request_admission";

export type ResolvedExportTargets = Readonly<
  Partial<Record<ExportFormat, string>>
>;

type Reservation = {
  readonly id: string;
  readonly request: ExportPreparationRequest;
  stage: ExportPreparationStage;
  snapshot: ResultSnapshot | null;
  cancelled: boolean;
  cancel_reason: "cancelled" | "destination-returned";
  running: Promise<void>;
  heartbeat: NodeJS.Timeout | null;
  selecting_destination: boolean;
  directory: string | null;
  targets: ResolvedExportTargets | null;
  target_identities: Readonly<
    Partial<Record<ExportFormat, TargetIdentity>>
  > | null;
};

type Task = {
  readonly id: string;
  readonly reservation_id: string;
  readonly request: ExportPreparationRequest;
  readonly host: ExportHost;
  readonly target_paths: readonly string[];
  stage: ExportStage;
  cancelling: boolean;
  terminal_error: Error | null;
  running: Promise<void>;
  heartbeat: NodeJS.Timeout | null;
};

export interface ExportTaskDependencies {
  readonly random_uuid?: () => string;
  readonly heartbeat_ms?: number;
  readonly host_factory?: (request: ExportHostRequest) => ExportHost;
  readonly files?: Pick<ExportFiles, "lstat"> & {
    realpath(path: string): Promise<string>;
  };
}

function readable_error(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function redact_quoted_absolute_paths(message: string): string {
  return message.replace(
    /(['"])(?:(?:[a-z]:[\\/])|(?:\\\\))[^'"]+\1/gi,
    "$1文件$1",
  );
}

export class ExportTaskCoordinator {
  private reservation: Reservation | null = null;
  private task: Task | null = null;

  constructor(
    private readonly result_editor: ResultEditor,
    private readonly admission: UserRequestAdmission,
    private readonly emit: (event: DesktopExportEvent) => void,
    private readonly dependencies: ExportTaskDependencies = {},
  ) {}

  get active(): boolean {
    return this.reservation !== null || this.task !== null;
  }

  prepare(value: unknown): ExportPreparationAccepted {
    const request = validate_export_preparation_request(value);
    const id = (this.dependencies.random_uuid ?? randomUUID)();
    this.admission.reserve_export(id);
    const reservation: Reservation = {
      id,
      request,
      stage: "saving_fields",
      snapshot: null,
      cancelled: false,
      cancel_reason: "cancelled",
      running: Promise.resolve(),
      heartbeat: null,
      selecting_destination: false,
      directory: null,
      targets: null,
      target_identities: null,
    };
    this.reservation = reservation;
    this.emit_preparation(reservation, "preparation-status");
    this.start_reservation_heartbeat(reservation);
    reservation.running = this.build_snapshot(reservation);
    return { reservation_id: id };
  }

  commit_reservation(
    reservation_id: string,
    targets: ResolvedExportTargets,
    target_identities: Readonly<Partial<Record<ExportFormat, TargetIdentity>>>,
  ): string {
    const reservation = this.reservation;
    if (
      !reservation ||
      reservation.id !== reservation_id ||
      reservation.stage !== "awaiting_destination" ||
      !reservation.snapshot ||
      reservation.cancelled
    )
      throw new Error("export reservation is not ready");
    this.validate_targets(reservation.request, targets);
    const task_id = (this.dependencies.random_uuid ?? randomUUID)();
    const host = (
      this.dependencies.host_factory ?? ((request) => new ExportHost(request))
    )({
      job_id: task_id,
      formats: reservation.request.formats,
      destinations: targets,
      target_identities,
      view_model: reservation.snapshot.view_model,
      on_progress: (progress) => this.handle_progress(task_id, progress),
    });
    this.admission.handoff_export(reservation.id, task_id);
    this.stop_heartbeat(reservation);
    this.reservation = null;
    const task: Task = {
      id: task_id,
      reservation_id: reservation.id,
      request: reservation.request,
      host,
      target_paths: reservation.request.formats.map(
        (format) => targets[format]!,
      ),
      stage: "preparing",
      cancelling: false,
      terminal_error: null,
      running: Promise.resolve(),
      heartbeat: null,
    };
    this.task = task;
    this.emit({
      type: "started",
      reservation_id: reservation.id,
      task_id,
      formats: [...reservation.request.formats],
      base_name: reservation.request.base_name,
    });
    this.start_task_heartbeat(task);
    task.running = this.run_task(task);
    return task_id;
  }

  async select_destination(
    value: unknown,
    choose_directory: () => Promise<string | null>,
  ): Promise<ExportDestinationSelection> {
    const { reservation_id } = validate_export_destination_request(value);
    const reservation = this.require_destination_reservation(reservation_id);
    if (reservation.selecting_destination)
      throw new Error("export destination selection is already active");
    reservation.selecting_destination = true;
    let selected: string | null;
    try {
      selected = await choose_directory();
    } catch (reason) {
      const failure = readable_error(reason);
      if (this.reservation === reservation)
        throw this.fail_reservation(reservation, failure);
      throw new Error(redact_quoted_absolute_paths(failure.message), {
        cause: reason,
      });
    } finally {
      reservation.selecting_destination = false;
    }
    if (this.reservation !== reservation) return { status: "returned" };
    if (!selected) {
      this.finish_cancelled_reservation(reservation, "destination-returned");
      return { status: "returned" };
    }
    try {
      const files = this.dependencies.files ?? node_files;
      reservation.directory = resolve(selected);
      const directory = resolve(await files.realpath(selected));
      const directory_stat = await files.lstat(directory, { bigint: true });
      if (!directory_stat.isDirectory())
        throw new Error("export destination must be a directory");
      const targets = this.resolve_targets(reservation.request, directory);
      const identities: Partial<Record<ExportFormat, TargetIdentity>> = {};
      for (const format of reservation.request.formats)
        identities[format] = await inspect_target_identity(
          files,
          targets[format]!,
        );
      reservation.directory = directory;
      reservation.targets = targets;
      reservation.target_identities = identities;
      const existing = reservation.request.formats.filter(
        (format) => identities[format]?.exists,
      );
      if (existing.length > 0)
        return {
          status: "overwrite-required",
          files: existing.map((format) => basename(targets[format]!)),
        };
      return {
        status: "started",
        task_id: this.commit_reservation(reservation.id, targets, identities),
      };
    } catch (reason) {
      const failure = readable_error(reason);
      if (this.reservation === reservation)
        throw this.fail_reservation(reservation, failure);
      throw new Error(redact_quoted_absolute_paths(failure.message), {
        cause: reason,
      });
    }
  }

  async confirm_overwrite(
    value: unknown,
  ): Promise<ExportOverwriteConfirmation> {
    const { reservation_id } = validate_export_destination_request(value);
    const reservation = this.require_destination_reservation(reservation_id);
    if (!reservation.targets || !reservation.target_identities)
      throw new Error("export overwrite is not awaiting confirmation");
    try {
      const files = this.dependencies.files ?? node_files;
      for (const format of reservation.request.formats) {
        const current = await inspect_target_identity(
          files,
          reservation.targets[format]!,
        );
        if (
          !target_identity_equal(
            reservation.target_identities[format]!,
            current,
          )
        )
          throw new Error(
            "export target changed before overwrite confirmation",
          );
      }
      return {
        status: "started",
        task_id: this.commit_reservation(
          reservation.id,
          reservation.targets,
          reservation.target_identities,
        ),
      };
    } catch (reason) {
      const failure = readable_error(reason);
      if (this.reservation === reservation)
        throw this.fail_reservation(reservation, failure);
      throw new Error(redact_quoted_absolute_paths(failure.message), {
        cause: reason,
      });
    }
  }

  async cancel(value: unknown): Promise<void> {
    const request: ExportCancelRequest = validate_export_cancel_request(value);
    if ("reservation_id" in request) {
      const reservation = this.reservation;
      if (!reservation || reservation.id !== request.reservation_id) return;
      if (!reservation.cancelled) {
        reservation.cancelled = true;
        reservation.cancel_reason = request.reason;
        reservation.stage = "cancelling";
        this.emit_preparation(reservation, "preparation-status");
      }
      if (reservation.snapshot) {
        this.finish_cancelled_reservation(reservation, request.reason);
        return;
      }
      await reservation.running;
      return;
    }
    const task = this.task;
    if (!task || task.id !== request.task_id) return;
    if (!task.cancelling) {
      task.cancelling = true;
      this.emit({ type: "cancelling", task_id: task.id });
      void task.host.cancel().catch(() => undefined);
    }
    await task.running;
  }

  async shutdown(): Promise<void> {
    const reservation = this.reservation;
    const task = this.task;
    await Promise.all([
      reservation
        ? this.cancel({ reservation_id: reservation.id, reason: "cancelled" })
        : Promise.resolve(),
      task ? this.cancel({ task_id: task.id }) : Promise.resolve(),
    ]);
    if (task?.terminal_error) throw task.terminal_error;
  }

  private async build_snapshot(reservation: Reservation): Promise<void> {
    try {
      await this.result_editor.wait_for_pending_saves(
        reservation.request.session_id,
      );
      if (reservation.cancelled) {
        this.finish_cancelled_reservation(
          reservation,
          reservation.cancel_reason,
        );
        return;
      }
      reservation.stage = "building_snapshot";
      this.emit_preparation(reservation, "preparation-status");
      reservation.snapshot = this.result_editor.snapshot_now(
        reservation.request.session_id,
      );
      if (reservation.cancelled) {
        this.finish_cancelled_reservation(
          reservation,
          reservation.cancel_reason,
        );
        return;
      }
      reservation.stage = "awaiting_destination";
      this.emit_preparation(reservation, "preparation-status");
      this.emit({ type: "preparation-ready", reservation_id: reservation.id });
    } catch (reason) {
      if (reservation.cancelled) {
        this.finish_cancelled_reservation(
          reservation,
          reservation.cancel_reason,
        );
        return;
      }
      this.fail_reservation(reservation, readable_error(reason));
    }
  }

  private finish_cancelled_reservation(
    reservation: Reservation,
    reason: "cancelled" | "destination-returned",
  ): void {
    reservation.directory = null;
    reservation.targets = null;
    reservation.target_identities = null;
    this.stop_heartbeat(reservation);
    if (this.reservation === reservation) this.reservation = null;
    this.admission.release_export(reservation.id);
    this.emit({
      type: "preparation-cancelled",
      reservation_id: reservation.id,
      reason,
    });
  }

  private async run_task(task: Task): Promise<void> {
    try {
      await task.host.start();
      this.emit({
        type: "completed",
        task_id: task.id,
        saved: this.desktop_artifacts(task.host.saved_artifacts),
      });
    } catch (reason) {
      const saved = this.desktop_artifacts(task.host.saved_artifacts);
      if (reason instanceof ExportCancelledError && saved.length === 0) {
        this.emit({ type: "cancelled", task_id: task.id, saved });
      } else {
        const saved_formats = new Set(saved.map(({ format }) => format));
        let failure = readable_error(reason);
        let residual_paths: string[];
        try {
          residual_paths = await task.host.inspect_residual_paths();
        } catch (inspection_error) {
          const inspection = readable_error(inspection_error);
          failure = new Error(
            `${failure.message}; failed to inspect export cleanup: ${inspection.message}`,
          );
          residual_paths = task.host.residual_paths;
        }
        if (task.host.cleanup_failed || residual_paths.length > 0)
          task.terminal_error = failure;
        this.emit({
          type: "failed",
          task_id: task.id,
          message: this.redact_paths(failure.message, task.target_paths),
          saved,
          failed: task.request.formats.filter(
            (format) => !saved_formats.has(format),
          ),
          residual_files: residual_paths.map((path) => basename(path)),
        });
      }
    } finally {
      this.stop_heartbeat(task);
      if (this.task === task) this.task = null;
      this.admission.release_export(task.id);
    }
  }

  private handle_progress(task_id: string, progress: ExportHostProgress): void {
    const task = this.task;
    if (!task || task.id !== task_id || task.cancelling) return;
    task.stage = progress.stage;
    this.emit({ type: "progress", task_id, ...progress });
  }

  private require_destination_reservation(reservation_id: string): Reservation {
    const reservation = this.reservation;
    if (
      !reservation ||
      reservation.id !== reservation_id ||
      reservation.stage !== "awaiting_destination" ||
      !reservation.snapshot ||
      reservation.cancelled
    )
      throw new Error("export reservation is not ready for a destination");
    return reservation;
  }

  private resolve_targets(
    request: ExportPreparationRequest,
    directory: string,
  ): ResolvedExportTargets {
    const targets: Partial<Record<ExportFormat, string>> = {};
    for (const format of request.formats) {
      const component = `${request.base_name}.${format}`;
      if (component.length > 255)
        throw new Error("export file name is too long for Windows");
      const target = resolve(join(directory, component));
      const relation = relative(directory, target);
      if (!relation || relation.startsWith("..") || isAbsolute(relation))
        throw new Error("export target escapes the selected directory");
      if (target.length >= 32_767)
        throw new Error("export path is too long for Windows");
      targets[format] = target;
    }
    return targets;
  }

  private fail_reservation(reservation: Reservation, error: Error): Error {
    const message = this.redact_paths(
      error.message,
      Object.values(reservation.targets ?? {}).filter((path): path is string =>
        Boolean(path),
      ),
      reservation.directory,
    );
    this.stop_heartbeat(reservation);
    reservation.directory = null;
    reservation.targets = null;
    reservation.target_identities = null;
    if (this.reservation === reservation) this.reservation = null;
    this.admission.release_export(reservation.id);
    this.emit({
      type: "preparation-failed",
      reservation_id: reservation.id,
      message,
    });
    return new Error(message, { cause: error });
  }

  private desktop_artifacts(saved: readonly SavedExportArtifact[]) {
    return saved.map(({ format, path }) => ({
      format,
      file_name: basename(path),
    }));
  }

  private redact_paths(
    message: string,
    paths: readonly string[],
    directory?: string | null,
  ): string {
    const redacted = [...paths]
      .sort((left, right) => right.length - left.length)
      .reduce((value, path) => value.split(path).join(basename(path)), message);
    return redact_quoted_absolute_paths(
      directory ? redacted.split(directory).join("所选目录") : redacted,
    );
  }

  private validate_targets(
    request: ExportPreparationRequest,
    targets: ResolvedExportTargets,
  ): void {
    const paths = request.formats.map((format) => {
      const path = targets[format];
      if (
        !path ||
        !isAbsolute(path) ||
        extname(path).toLowerCase() !== `.${format}`
      )
        throw new Error(`invalid ${format} export target`);
      if (basename(path, `.${format}`) !== request.base_name)
        throw new Error("export target does not match the reserved base name");
      return path;
    });
    if (new Set(paths.map(dirname)).size !== 1)
      throw new Error("export targets must use one directory");
    for (const format of ["mp4", "png"] as const)
      if (!request.formats.includes(format) && targets[format])
        throw new Error("unexpected export target");
  }

  private emit_preparation(
    reservation: Reservation,
    type: "preparation-status" | "preparation-heartbeat",
  ): void {
    this.emit({
      type,
      reservation_id: reservation.id,
      stage: reservation.stage,
    });
  }

  private start_reservation_heartbeat(reservation: Reservation): void {
    reservation.heartbeat = setInterval(() => {
      if (this.reservation === reservation)
        this.emit_preparation(reservation, "preparation-heartbeat");
    }, this.dependencies.heartbeat_ms ?? 1_000);
    reservation.heartbeat.unref();
  }

  private start_task_heartbeat(task: Task): void {
    task.heartbeat = setInterval(() => {
      if (this.task === task)
        this.emit({ type: "heartbeat", task_id: task.id, stage: task.stage });
    }, this.dependencies.heartbeat_ms ?? 1_000);
    task.heartbeat.unref();
  }

  private stop_heartbeat(value: Reservation | Task): void {
    if (value.heartbeat) clearInterval(value.heartbeat);
    value.heartbeat = null;
  }
}
