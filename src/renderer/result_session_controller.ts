import {
  DISPLAY_FIELD_KEYS,
  type DisplayFields,
  type ResultEditorState,
} from "../shared/result_editor";
import type { DesktopApi } from "../shared/installed_config";
import { validate_display_config } from "../visualize/data/validate_display_config";
import {
  apply_cdf_display,
  prepare_cdf_data,
  type PreparedCDFData,
} from "../visualize/view/cdf_view_model";
import type { CDFViewModel } from "../visualize/types/cdf";

export type ResultSessionState = Readonly<{
  result: ResultEditorState | null;
  draft: DisplayFields | null;
  model: CDFViewModel | null;
  preview: CDFViewModel | null;
  loading: boolean;
  saving: boolean;
  status?: string;
  load_status?: string;
  load_error: string | null;
  save_error: string | null;
}>;

type Session = {
  result: ResultEditorState;
  numeric: PreparedCDFData;
  draft: DisplayFields;
  revision: number;
  enqueued_revision: number;
  save_id: number;
  pending: number;
  queue: Promise<void>;
  error: Error | null;
};

function error_of(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function fields_equal(left: DisplayFields, right: DisplayFields): boolean {
  return DISPLAY_FIELD_KEYS.every((key) => left[key] === right[key]);
}

/** App-owned state survives page unmounts; main owns file and session identity. */
export class ResultSessionController {
  private session: Session | null = null;
  private loading: Promise<boolean> | null = null;
  private load_id = 0;
  private readonly listeners = new Set<() => void>();
  private state: ResultSessionState = {
    result: null,
    draft: null,
    model: null,
    preview: null,
    loading: false,
    saving: false,
    load_error: null,
    save_error: null,
  };

  constructor(
    private readonly api: Pick<
      DesktopApi,
      "selectGsrResult" | "saveResultFields"
    >,
  ) {}

  get_snapshot = (): ResultSessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private update(patch: Partial<ResultSessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  select_result = (): Promise<boolean> => {
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
        const result = await Promise.resolve().then(() =>
          this.api.selectGsrResult(),
        );
        if (request !== this.load_id) return false;
        if (!result) {
          this.update({ status: "未选择文件。", load_status: "未选择文件。" });
          return false;
        }
        const numeric = prepare_cdf_data(result.analysis);
        const model = apply_cdf_display(numeric, result.display);
        this.session = {
          result,
          numeric,
          draft: result.fields,
          revision: 0,
          enqueued_revision: -1,
          save_id: 0,
          pending: 0,
          queue: Promise.resolve(),
          error: null,
        };
        this.update({
          result,
          draft: result.fields,
          model,
          preview: model,
          saving: false,
          save_error: null,
          status: "分析完成，尚无未保存更改。",
          load_status: undefined,
        });
        return true;
      } catch (reason) {
        if (request === this.load_id)
          this.update({
            load_error: error_of(reason).message,
            status: "分析失败。",
            load_status: "分析失败。",
          });
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
  };

  change_field = (key: keyof DisplayFields, value: string): void => {
    const session = this.session;
    if (!session || this.state.loading || session.draft[key] === value) return;
    session.draft = { ...session.draft, [key]: value };
    session.revision += 1;
    this.update({
      draft: session.draft,
      preview: apply_cdf_display(session.numeric, {
        ...session.result.display,
        ...session.draft,
      }),
    });
  };

  save = (): Promise<void> => {
    const session = this.session;
    if (!session) return Promise.resolve();
    if (session.pending && session.enqueued_revision === session.revision)
      return session.queue;
    if (
      !session.pending &&
      !session.error &&
      fields_equal(session.draft, session.result.fields)
    )
      return Promise.resolve();
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
        if (this.session !== session)
          throw new Error("result session has changed");
        const saved = await this.api.saveResultFields({
          session_id: session.result.session_id,
          fields,
        });
        if (this.session !== session) return;
        if (saved.session_id !== session.result.session_id)
          throw new Error("result session has changed");
        const display = validate_display_config(saved.display);
        const saved_fields: DisplayFields = Object.fromEntries(
          DISPLAY_FIELD_KEYS.map((key) => [key, display[key]]),
        ) as DisplayFields;
        session.result = { ...session.result, display, fields: saved_fields };
        session.error = null;
        const model = apply_cdf_display(session.numeric, display);
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
          session.error = error_of(reason);
          if (request === session.save_id)
            this.update({
              save_error: session.error.message,
              ...(!this.state.loading
                ? { status: "保存失败，现有 sidecar 未被覆盖。" }
                : {}),
            });
        }
        throw reason;
      })
      .finally(() => {
        session.pending -= 1;
        if (this.session === session)
          this.update({ saving: session.pending > 0 });
      });
    session.queue = operation.catch(() => undefined);
    return operation;
  };

  wait_for_saves = async (session_id: string): Promise<void> => {
    const session = this.session;
    const assert_current = () => {
      if (
        !session ||
        this.session !== session ||
        session.result.session_id !== session_id ||
        this.state.loading
      )
        throw new Error("result session has changed; please export again");
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
