import {
  DISPLAY_FIELD_KEYS,
  type DisplayFields,
} from "../shared/result_editor";
import {
  validateDisplayConfig,
  type ResultCandidateSession,
} from "../shared/tauri_desktop_contract";
import {
  apply_curve_display,
  prepare_curve_data,
  type CurveViewModel,
  type PreparedCurveData,
} from "../visualize/data/curve_model";
import { toDesktopError, type TauriDesktopClient } from "./desktop_client";

export type TauriResultSessionState = Readonly<{
  result: ResultCandidateSession | null;
  draft: DisplayFields | null;
  model: CurveViewModel | null;
  preview: CurveViewModel | null;
  loading: boolean;
  saving: boolean;
  discarding: boolean;
  status?: string;
  load_status?: string;
  load_error: string | null;
  save_error: string | null;
}>;

type ActiveSession = {
  result: ResultCandidateSession;
  prepared: PreparedCurveData;
  draft: DisplayFields;
  revision: number;
  enqueued_revision: number;
  save_id: number;
  pending: number;
  queue: Promise<void>;
  error: Error | null;
};

export function display_fields_equal(
  left: DisplayFields,
  right: DisplayFields,
): boolean {
  return DISPLAY_FIELD_KEYS.every((key) => left[key] === right[key]);
}

/**
 * App-owned result session controller implementing two-phase candidate
 * confirmation: build BigInt-exact curve data before confirming the session
 * switch with the host, preserving the active result on any error or stale
 * confirmation.
 */
export class TauriResultSessionController {
  private session: ActiveSession | null = null;
  private loading: Promise<boolean> | null = null;
  private load_id = 0;
  private readonly listeners = new Set<() => void>();
  private state: TauriResultSessionState = {
    result: null,
    draft: null,
    model: null,
    preview: null,
    loading: false,
    saving: false,
    discarding: false,
    load_error: null,
    save_error: null,
  };

  constructor(
    private readonly client: Pick<
      TauriDesktopClient,
      | "selectGsrResult"
      | "openSimulationResult"
      | "confirmResultSession"
      | "saveResultFields"
      | "discardResultDraft"
    >,
  ) {}

  get_snapshot = (): TauriResultSessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private update(patch: Partial<TauriResultSessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  select_result = (): Promise<boolean> =>
    this.load_candidate(() => this.client.selectGsrResult());

  open_simulation_result = (): Promise<boolean> =>
    this.load_candidate(async () => {
      await this.save();
      if (this.session?.error) throw this.session.error;
      return this.client.openSimulationResult();
    });

  private load_candidate(
    load: () => Promise<ResultCandidateSession | null>,
  ): Promise<boolean> {
    if (this.state.discarding) return Promise.resolve(false);
    if (this.loading) return this.loading;
    const request = ++this.load_id;
    this.update({
      loading: true,
      load_error: null,
      status: "正在分析…",
      load_status: "正在分析…",
    });
    const operation = (async () => {
      try {
        const candidate = await Promise.resolve().then(load);
        if (request !== this.load_id) return false;
        if (!candidate) {
          this.update({ status: "未选择文件。", load_status: "未选择文件。" });
          return false;
        }
        // Build exact curve data & display model BEFORE confirming session switch.
        const prepared = prepare_curve_data(candidate.analysis);
        const model = apply_curve_display(prepared, candidate.display);

        const confirmation = await this.client.confirmResultSession({
          sessionId: candidate.sessionId,
        });
        if (request !== this.load_id) return false;
        if (
          !confirmation.confirmed ||
          confirmation.activeSessionId !== candidate.sessionId
        ) {
          this.update({
            load_error: "结果会话已过期，当前结果保持不变。",
            status: "会话确认已过期。",
            load_status: "会话确认已过期。",
          });
          return false;
        }

        this.session = {
          result: candidate,
          prepared,
          draft: candidate.fields,
          revision: 0,
          enqueued_revision: -1,
          save_id: 0,
          pending: 0,
          queue: Promise.resolve(),
          error: null,
        };
        this.update({
          result: candidate,
          draft: candidate.fields,
          model,
          preview: model,
          saving: false,
          save_error: null,
          status: "分析完成，尚无未保存更改。",
          load_status: undefined,
        });
        return true;
      } catch (reason) {
        if (request === this.load_id) {
          this.update({
            load_error: toDesktopError(reason).message,
            status: "分析失败。",
            load_status: "分析失败。",
          });
        }
        return false;
      } finally {
        if (request === this.load_id) {
          this.loading = null;
          this.update({ loading: false });
        }
      }
    })();
    this.loading = operation;
    return operation;
  }

  change_field = (key: keyof DisplayFields, value: string): void => {
    const session = this.session;
    if (
      !session ||
      this.state.loading ||
      this.state.discarding ||
      session.draft[key] === value
    ) {
      return;
    }
    session.draft = { ...session.draft, [key]: value };
    session.revision += 1;
    this.update({
      draft: session.draft,
      preview: apply_curve_display(session.prepared, {
        ...session.result.display,
        ...session.draft,
      }),
    });
  };

  discard_failed_draft = async (): Promise<boolean> => {
    const session = this.session;
    if (
      !session?.error ||
      session.pending ||
      this.state.loading ||
      this.state.discarding
    ) {
      return false;
    }
    this.update({ discarding: true });
    try {
      await this.client.discardResultDraft({
        sessionId: session.result.sessionId,
      });
      session.draft = session.result.fields;
      session.error = null;
      this.update({
        draft: session.draft,
        preview: this.state.model,
        save_error: null,
        load_error: null,
        load_status: undefined,
        status: "已放弃未保存更改。",
      });
      return true;
    } catch (reason) {
      this.update({
        save_error: `无法放弃更改。${toDesktopError(reason).message}`,
      });
      return false;
    } finally {
      this.update({ discarding: false });
    }
  };

  save = (): Promise<void> => {
    const session = this.session;
    if (!session || this.state.discarding) return Promise.resolve();
    if (session.pending && session.enqueued_revision === session.revision) {
      return session.queue;
    }
    if (
      !session.pending &&
      !session.error &&
      display_fields_equal(session.draft, session.result.fields)
    ) {
      return Promise.resolve();
    }
    const fields = session.draft;
    const revision = session.revision;
    const request = ++session.save_id;
    session.enqueued_revision = revision;
    session.pending += 1;
    this.update({
      saving: true,
      save_error: null,
      ...(!this.state.loading ? { status: "正在保存…" } : {}),
    });
    const operation = session.queue
      .then(async () => {
        if (this.session !== session) {
          throw new Error("result session has changed");
        }
        const saved = await this.client.saveResultFields({
          sessionId: session.result.sessionId,
          fields,
        });
        if (this.session !== session) return;
        if (saved.sessionId !== session.result.sessionId) {
          throw new Error("result session has changed");
        }
        const display = validateDisplayConfig(saved.display);
        const saved_fields = Object.fromEntries(
          DISPLAY_FIELD_KEYS.map((key) => [key, display[key]]),
        ) as DisplayFields;
        session.result = { ...session.result, display, fields: saved_fields };
        session.error = null;
        const model = apply_curve_display(session.prepared, display);
        if (session.revision === revision) session.draft = saved_fields;
        this.update({
          result: session.result,
          model,
          draft: session.draft,
          ...(session.revision === revision ? { preview: model } : {}),
          ...(request === session.save_id
            ? {
                save_error: null,
                ...(!this.state.loading
                  ? {
                      status:
                        session.revision === revision
                          ? "已保存。"
                          : "仍有未保存更改。",
                    }
                  : {}),
              }
            : {}),
        });
      })
      .catch((reason) => {
        if (this.session === session) {
          session.error = toDesktopError(reason);
          if (request === session.save_id) {
            this.update({
              save_error: session.error.message,
              ...(!this.state.loading
                ? { status: "保存失败，现有 sidecar 未被覆盖。" }
                : {}),
            });
          }
        }
        throw reason;
      })
      .finally(() => {
        session.pending -= 1;
        if (this.session === session) {
          this.update({ saving: session.pending > 0 });
        }
      });
    session.queue = operation.catch(() => undefined);
    return operation;
  };

  wait_for_saves = async (sessionId: string): Promise<void> => {
    const session = this.session;
    const assert_current = () => {
      if (
        !session ||
        this.session !== session ||
        session.result.sessionId !== sessionId ||
        this.state.loading ||
        this.state.discarding
      ) {
        throw new Error("result session has changed; please export again");
      }
    };
    assert_current();
    if (session?.error && !session.pending) throw session.error;
    await this.save();
    for (;;) {
      const barrier = session!.queue;
      await barrier;
      assert_current();
      if (barrier !== session!.queue) continue;
      if (session!.error) throw session!.error;
      return;
    }
  };
}
