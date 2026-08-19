import {
  BarChart3,
  FilePenLine,
  FolderOpen,
  Play,
  Search,
  Store,
} from "lucide-react";
import {
  useState,
  useEffect,
  useRef,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  ConfigRepositoryState,
  InstalledConfig,
  RepositoryConfig,
} from "../shared/installed_config";
import type { DisplayFields, ResultEditorState } from "../shared/result_editor";
import {
  default_result_item,
  filter_result_items,
  selected_result_item,
} from "./simulation_items";
import VisualizeApp from "../visualize/App";
import { ANIMATION_TOTAL_MS } from "../visualize/animation/timeline";
import { build_animation_progress } from "../visualize/animation/progress";
import { CDFChart } from "../visualize/components/CDFChart";
import { build_cdf_view_model } from "../visualize/view/cdf_view_model";
import { get_distribution_statistic_groups } from "../visualize/view/statistic_view_config";
import {
  MAX_TOTAL_RUNS,
  validate_simulation_request,
  type SimulationRequest,
  type SimulationStage,
  type SimulationStatus,
} from "../shared/simulation";

type Page =
  | "simulation"
  | "config-repository"
  | "result-editor"
  | "result-visualize";

const pages: Array<{
  id: Page;
  label: string;
  icon: ReactNode;
}> = [
  {
    id: "simulation",
    label: "运行模拟",
    icon: <Play aria-hidden="true" size={18} />,
  },
  {
    id: "config-repository",
    label: "配置仓库",
    icon: <Store aria-hidden="true" size={18} />,
  },
  {
    id: "result-editor",
    label: "结果编辑",
    icon: <FilePenLine aria-hidden="true" size={18} />,
  },
  {
    id: "result-visualize",
    label: "结果可视化",
    icon: <BarChart3 aria-hidden="true" size={18} />,
  },
];

const status_labels: Record<SimulationStatus, string> = {
  idle: "待运行",
  starting: "正在启动",
  running: "模拟中",
  saving: "正在保存",
  completed: "已完成",
  failed: "运行失败",
  cancelling: "正在取消",
  cancelled: "已取消",
};

const result_statistic_keys = get_distribution_statistic_groups().flatMap(
  ({ keys }) => keys,
);

function SimulationPage({ active }: { active: boolean }) {
  const [configs, set_configs] = useState<InstalledConfig[]>([]);
  const [selected_key, set_selected_key] = useState("");
  const [loading, set_loading] = useState(true);
  const [config_error, set_config_error] = useState<string | null>(null);
  const [operation_error, set_operation_error] = useState<string | null>(null);
  const [termination, set_termination] = useState("");
  const [result_item, set_result_item] = useState("");
  const [item_query, set_item_query] = useState("");
  const [target_value, set_target_value] = useState("10");
  const [seed, set_seed] = useState("0");
  const [threads, set_threads] = useState("1");
  const [logical_cpu_count, set_logical_cpu_count] = useState(1);
  const [status, set_status] = useState<SimulationStatus>("idle");
  const [stage, set_stage] = useState<SimulationStage | null>(null);
  const [progress, set_progress] = useState<{
    completed: number;
    total: number;
    unit: string;
  } | null>(null);
  const [result_path, set_result_path] = useState("");
  const key = (config: InstalledConfig) => `${config.source}:${config.id}`;
  const selected =
    configs.find((config) => key(config) === selected_key) ?? configs[0];
  const filtered_items = filter_result_items(selected?.items ?? [], item_query);
  const selected_item = selected?.items.find(({ id }) => id === result_item);

  useEffect(() => {
    if (!active) return;
    if (!window.desktopApi) {
      set_config_error("配置扫描 API 不可用，请从 Electron 启动。");
      set_loading(false);
      return;
    }
    set_config_error(null);
    set_loading(true);
    Promise.all([
      window.desktopApi.listConfigs(),
      window.desktopApi.getLogicalCpuCount(),
    ])
      .then(([value, cpu_count]) => {
        set_configs(value);
        set_logical_cpu_count(cpu_count);
        set_selected_key((current) =>
          value.some((config) => key(config) === current)
            ? current
            : value[0]
              ? key(value[0])
              : "",
        );
        set_termination(value[0]?.terminations[0]?.file ?? "");
      })
      .catch(() => set_config_error("配置扫描失败，请检查本地配置目录。"))
      .finally(() => set_loading(false));
  }, [active]);

  useEffect(() => {
    if (!window.desktopApi) return;
    return window.desktopApi.onSimulationEvent(
      ({ status: next_status, event, message }) => {
        set_status(next_status);
        if (event?.type === "started") set_stage("loading_config");
        if (event?.type === "stage") set_stage(event.stage);
        if (event?.type === "progress") set_progress(event);
        if (event?.type === "completed") set_result_path(event.result_path);
        if (message) set_operation_error(message);
      },
    );
  }, []);

  useEffect(() => {
    set_termination(selected?.terminations[0]?.file ?? "");
    set_result_item(default_result_item(selected?.items ?? []));
    set_item_query("");
  }, [selected]);

  const busy = ["starting", "running", "saving", "cancelling"].includes(status);
  const start = async () => {
    set_operation_error(null);
    set_progress(null);
    set_result_path("");
    set_stage("loading_config");
    const canonical_result_item = selected_result_item(
      result_item,
      selected?.items ?? [],
    );
    if (!canonical_result_item) {
      set_status("failed");
      set_operation_error("请选择当前配置中的统计物品 ID");
      return;
    }
    set_result_item(canonical_result_item);
    const request: SimulationRequest = {
      configSource: selected?.source ?? "installed",
      configId: selected?.id ?? "",
      termination,
      resultItem: canonical_result_item,
      target: {
        kind: "totalRuns",
        value: Number(target_value),
      } as SimulationRequest["target"],
      seed: Number(seed),
      threads: Number(threads),
    };
    try {
      validate_simulation_request(request, logical_cpu_count);
      await window.desktopApi.startSimulation(request);
    } catch (reason) {
      set_status("failed");
      set_operation_error(
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  };

  const cancel = async () => {
    set_operation_error(null);
    try {
      await window.desktopApi.cancelSimulation();
    } catch (reason) {
      set_operation_error(
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  };

  const open_results = async () => {
    try {
      await window.desktopApi.openResultsDirectory();
    } catch (reason) {
      set_operation_error(
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  };

  const stage_index = {
    loading_config: 0,
    simulating: 1,
    saving: 2,
  }[stage ?? "loading_config"];
  const trace_state = (index: number) => {
    if (status === "completed") return "done";
    if (["failed", "cancelled"].includes(status) && index === stage_index)
      return "failed";
    if (status === "idle" || index > stage_index) return "pending";
    return index < stage_index ? "done" : "active";
  };

  return (
    <section
      hidden={!active}
      className="renderer-placeholder simulation-page"
      aria-labelledby="simulation-title"
    >
      <header className="page-heading">
        <div className="renderer-placeholder-mark" aria-hidden="true">
          <Play size={20} />
        </div>
        <div>
          <p className="renderer-eyebrow">SIMULATION CONSOLE</p>
          <h1 id="simulation-title">运行模拟</h1>
        </div>
      </header>
      {loading ? (
        <p>正在扫描配置…</p>
      ) : config_error ? (
        <p role="alert">{config_error}</p>
      ) : configs.length === 0 ? (
        <p>暂无可用配置，请先安装官方配置或选择本地配置目录。</p>
      ) : (
        <div className="simulation-workbench">
          <section
            className="instrument-panel simulation-selection"
            data-testid="simulation-selection"
          >
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">输入 / INPUT</p>
                <h2>配置与统计物品</h2>
              </div>
              <code>{selected?.id}</code>
            </div>
            <div className="simulation-config-fields">
              <label>
                配置
                <select
                  disabled={busy}
                  value={selected ? key(selected) : ""}
                  onChange={(event) => set_selected_key(event.target.value)}
                >
                  {configs.map((config) => (
                    <option key={key(config)} value={key(config)}>
                      {config.source === "installed" ? "官方配置" : "本地配置"}·{" "}
                      {config.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                终止条件
                <select
                  disabled={busy}
                  value={termination}
                  onChange={(event) => set_termination(event.target.value)}
                >
                  {selected?.terminations.map((item) => (
                    <option key={item.file} value={item.file}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="config-description">{selected?.description}</p>
            <div className="item-list-heading">
              <div>
                <span>统计物品</span>
                <small>
                  {filtered_items.length} / {selected?.items.length ?? 0}
                </small>
              </div>
              <label className="item-search">
                <Search aria-hidden="true" size={15} />
                <span className="sr-only">搜索统计物品</span>
                <input
                  autoComplete="off"
                  disabled={busy}
                  placeholder="搜索 ID 或中文名称"
                  type="search"
                  value={item_query}
                  onChange={(event) => set_item_query(event.target.value)}
                />
              </label>
            </div>
            <div
              aria-label="当前配置统计物品"
              className="simulation-item-panel"
              data-testid="simulation-item-list"
              role="radiogroup"
            >
              {filtered_items.map((item) => (
                <label className="simulation-item" key={item.id}>
                  <input
                    checked={result_item === item.id}
                    disabled={busy}
                    name="result-item"
                    type="radio"
                    value={item.id}
                    onChange={() => set_result_item(item.id)}
                  />
                  <span>
                    <code>{item.id}</code>
                    <strong>{item.name}</strong>
                  </span>
                </label>
              ))}
              {filtered_items.length === 0 && (
                <p className="item-empty">没有匹配项，请更换 ID 或名称。</p>
              )}
            </div>
          </section>

          <section className="instrument-panel simulation-control">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">执行 / EXECUTE</p>
                <h2>运行控制</h2>
              </div>
              <span className="status-badge" data-status={status}>
                {status_labels[status]}
              </span>
            </div>
            <div className="simulation-fields">
              <label className="target-field">
                固定次数
                <input
                  disabled={busy}
                  max={MAX_TOTAL_RUNS}
                  min="1"
                  type="number"
                  value={target_value}
                  onChange={(event) => set_target_value(event.target.value)}
                />
              </label>
              <label>
                随机种子
                <input
                  disabled={busy}
                  step="1"
                  type="number"
                  value={seed}
                  onChange={(event) => set_seed(event.target.value)}
                />
              </label>
              <label>
                线程数 <span>1–{logical_cpu_count}</span>
                <input
                  disabled={busy}
                  max={logical_cpu_count}
                  min="1"
                  step="1"
                  type="number"
                  value={threads}
                  onChange={(event) => set_threads(event.target.value)}
                />
              </label>
            </div>
            <div className="output-item">
              <span>当前输出物品</span>
              <strong>{selected_item?.name ?? "未选择"}</strong>
              <code>{selected_item?.id ?? "—"}</code>
            </div>
            <div className="simulation-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => void start()}
              >
                <Play size={16} aria-hidden="true" />
                启动模拟
              </button>
              <button
                type="button"
                disabled={!busy || status === "cancelling"}
                onClick={() => void cancel()}
              >
                取消
              </button>
            </div>
            {operation_error && (
              <div className="simulation-error" role="alert">
                错误：{operation_error}
              </div>
            )}
            <ol className="simulation-trace" aria-label="模拟任务轨迹">
              {[
                ["编译配置", "YAML → IR"],
                [
                  "运行模拟",
                  progress
                    ? `${progress.completed} / ${progress.total} runs`
                    : "等待 core",
                ],
                [
                  "保存 GSR",
                  result_path ? result_path.split(/[\\/]/).pop() : "等待写入",
                ],
              ].map(([label, detail], index) => (
                <li data-state={trace_state(index)} key={label}>
                  <i aria-hidden="true" />
                  <span>
                    <strong>{label}</strong>
                    <small title={index === 2 ? result_path : undefined}>
                      {detail}
                    </small>
                  </span>
                </li>
              ))}
            </ol>
            {progress && (
              <progress
                aria-label="模拟进度"
                max={progress.total}
                value={progress.completed}
              />
            )}
            <div className="simulation-status" role="status">
              <span>状态 / {status_labels[status]}</span>
              {result_path && (
                <button type="button" onClick={() => void open_results()}>
                  <FolderOpen size={16} aria-hidden="true" />
                  打开结果目录
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function ResultEditorPage({
  state,
  on_state,
}: {
  state: ResultEditorState | null;
  on_state: (state: ResultEditorState) => void;
}) {
  const [fields, set_fields] = useState<DisplayFields | null>(null);
  const [status, set_status] = useState("请选择 GSR 文件。");
  const [loading, set_loading] = useState(false);
  const [saving, set_saving] = useState(false);
  const [error, set_error] = useState<string | null>(null);
  const fields_ref = useRef<DisplayFields | null>(null);
  const save_queue = useRef(Promise.resolve());
  const save_version = useRef(0);
  const preview_data =
    state && fields
      ? build_cdf_view_model(state.analysis, { ...state.display, ...fields })
      : null;
  const preview_metrics = preview_data
    ? new Map(preview_data.metrics.map((metric) => [metric.key, metric]))
    : null;
  const preview_animation = useMemo(
    () => build_animation_progress(ANIMATION_TOTAL_MS),
    [],
  );

  const apply_state = (next: ResultEditorState) => {
    on_state(next);
    fields_ref.current = next.fields;
    set_fields(next.fields);
  };

  useEffect(() => {
    fields_ref.current = state?.fields ?? null;
    set_fields(fields_ref.current);
  }, [state]);

  const select = async () => {
    set_loading(true);
    set_error(null);
    set_status("正在分析…");
    try {
      const next = await window.desktopApi.selectGsrResult();
      if (next) {
        apply_state(next);
        set_status("分析完成，尚无未保存更改。");
      } else {
        set_status("未选择文件。");
      }
    } catch (reason) {
      set_error(reason instanceof Error ? reason.message : String(reason));
      set_status("分析失败。");
    } finally {
      set_loading(false);
    }
  };

  const save = () => {
    const snapshot = fields_ref.current;
    if (!snapshot) return;
    const version = ++save_version.current;
    set_saving(true);
    set_error(null);
    set_status("正在保存…");
    save_queue.current = save_queue.current.then(async () => {
      try {
        const next = await window.desktopApi.saveResultFields(snapshot);
        if (version === save_version.current) {
          if (fields_ref.current === snapshot) apply_state(next);
          set_status("已保存。");
        }
      } catch (reason) {
        if (version === save_version.current) {
          set_error(reason instanceof Error ? reason.message : String(reason));
          set_status("保存失败，现有 sidecar 未被覆盖。");
        }
      } finally {
        if (version === save_version.current) set_saving(false);
      }
    });
  };

  const change_field = (key: keyof DisplayFields, value: string) =>
    set_fields((current) => {
      if (!current) return current;
      fields_ref.current = { ...current, [key]: value };
      return fields_ref.current;
    });

  const field = (
    key: keyof DisplayFields,
    label: string,
    multiline = false,
    class_name = "",
  ) => (
    <label className={class_name}>
      {label}
      {multiline ? (
        <textarea
          disabled={loading}
          value={fields?.[key] ?? ""}
          onBlur={save}
          onChange={(event) => change_field(key, event.target.value)}
        />
      ) : (
        <input
          disabled={loading}
          value={fields?.[key] ?? ""}
          onBlur={save}
          onChange={(event) => change_field(key, event.target.value)}
        />
      )}
    </label>
  );

  return (
    <section
      className="renderer-placeholder result-editor"
      aria-labelledby="result-title"
    >
      <header className="page-heading result-editor-header">
        <div className="renderer-placeholder-mark" aria-hidden="true">
          <FilePenLine size={20} />
        </div>
        <div>
          <p className="renderer-eyebrow">GSR RESULT EDITOR</p>
          <h1 id="result-title">结果展示信息</h1>
        </div>
        {state && (
          <button
            className="secondary"
            type="button"
            disabled={loading || saving}
            onClick={() => void select()}
          >
            更换 GSR
          </button>
        )}
      </header>
      {!state && (
        <div className="result-editor-empty">
          <div className="instrument-panel result-editor-empty-panel">
            <p className="panel-kicker">GSR WORKFLOW</p>
            <h2>载入模拟结果</h2>
            <p>
              选择 GSR 文件并完成分析后，即可编辑标题、目标、说明、价格和单位。
            </p>
            <button
              type="button"
              disabled={loading || saving}
              onClick={() => void select()}
            >
              <FolderOpen size={16} aria-hidden="true" />
              选择 GSR
            </button>
          </div>
        </div>
      )}
      {state && fields && preview_data && (
        <div className="result-editor-workbench">
          <div className="result-editor-left">
            <div className="instrument-panel result-editor-form">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">展示字段 / DISPLAY</p>
                  <h2>可视化文案</h2>
                </div>
                <span>失焦自动保存</span>
              </div>
              {field("title", "标题")}
              {field("target", "目标")}
              {field("result_item_name", "统计物品展示名称")}
              {field("note", "说明", false, "result-note")}
              {field("price", "价格", false, "result-price")}
              {field("unit", "单位", false, "result-unit")}
            </div>
            <section
              className="instrument-panel result-preview"
              data-testid="result-preview"
            >
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">分析 / ANALYSIS</p>
                  <h2>核心指标</h2>
                </div>
              </div>
              <div
                className="result-preview-scroll"
                data-testid="result-preview-scroll"
              >
                <div className="result-preview-body">
                  <div className="result-preview-summary">
                    <div className="result-metric-primary">
                      <span>结果指标</span>
                      <strong>{fields.result_item_name}</strong>
                      <code>{state.analysis.result_item.id}</code>
                    </div>
                    <div className="result-totals">
                      <div>
                        <span>累计模拟次数</span>
                        <strong>
                          {preview_data.runs.toLocaleString("zh-CN")}
                        </strong>
                      </div>
                      <div>
                        <span>累计{preview_data.result_item.name}</span>
                        <strong>{preview_data.total_display}</strong>
                      </div>
                    </div>
                  </div>
                  <dl className="quantile-preview">
                    {result_statistic_keys.map((key) => {
                      const metric = preview_metrics?.get(key);
                      return metric ? (
                        <div
                          key={key}
                          style={
                            {
                              "--metric-color": metric.color,
                            } as CSSProperties
                          }
                        >
                          <dt>{metric.key}</dt>
                          <dd>{metric.display_value}</dd>
                        </div>
                      ) : null;
                    })}
                  </dl>
                </div>
              </div>
            </section>
          </div>
          <aside
            className="instrument-panel result-cdf-preview"
            data-testid="result-cdf-preview"
          >
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">分布 / DISTRIBUTION</p>
                <h2>可视化预览</h2>
              </div>
            </div>
            <div className="result-cdf-chart">
              <CDFChart
                animation_progress={preview_animation}
                compact
                data={preview_data}
              />
            </div>
          </aside>
        </div>
      )}
      <p className="result-save-status" role="status">
        {status}
      </p>
      {error && (
        <p className="simulation-error" role="alert">
          错误：{error}
        </p>
      )}
    </section>
  );
}

const repository_status: Record<
  RepositoryConfig["status"],
  { label: string; action: string | null }
> = {
  available: { label: "可安装", action: "安装" },
  installed: { label: "已安装", action: null },
  update_available: { label: "可更新", action: "更新" },
  removed: { label: "已从源移除", action: null },
};

function ConfigRepositoryPage() {
  const [state, set_state] = useState<ConfigRepositoryState | null>(null);
  const [busy_id, set_busy_id] = useState<string | null>(null);
  const [message, set_message] = useState("正在读取配置状态…");
  const [error, set_error] = useState<string | null>(null);

  const run = async (
    label: string,
    operation: () => Promise<ConfigRepositoryState>,
    id: string | null = null,
  ) => {
    set_busy_id(id ?? label);
    set_error(null);
    set_message(
      label === "刷新"
        ? "正在刷新官方目录；若远端限流，最多等待 30 秒后重试一次，应用其他功能不受影响。"
        : `${label}中…`,
    );
    try {
      set_state(await operation());
      set_message(`${label}完成。`);
    } catch (reason) {
      set_error(reason instanceof Error ? reason.message : String(reason));
      set_message(`${label}失败，请按提示重试。`);
    } finally {
      set_busy_id(null);
    }
  };

  useEffect(() => {
    void window.desktopApi
      .getConfigRepositoryState()
      .then((initial) => {
        set_state(initial);
        set_message(
          "正在刷新官方目录；若远端限流，最多等待 30 秒后重试一次，应用其他功能不受影响。",
        );
        return window.desktopApi.refreshConfigRepository();
      })
      .then((refreshed) => {
        set_state(refreshed);
        set_message(
          refreshed.sourceError
            ? "官方目录离线；已安装和本地配置仍可使用。"
            : "官方目录已刷新。",
        );
      })
      .catch((reason: unknown) => {
        set_error(reason instanceof Error ? reason.message : String(reason));
        set_message("配置状态读取失败。");
      });
  }, []);

  const action = (config: RepositoryConfig) => {
    if (config.status === "available")
      return run(
        "安装",
        () => window.desktopApi.installConfig(config.id),
        config.id,
      );
    if (config.status === "update_available")
      return run(
        "更新",
        () => window.desktopApi.updateConfig(config.id),
        config.id,
      );
  };
  const repository_counts = {
    installed:
      state?.official.filter(({ status }) => status !== "available").length ??
      0,
    update:
      state?.official.filter(({ status }) => status === "update_available")
        .length ?? 0,
    available:
      state?.official.filter(({ status }) => status === "available").length ??
      0,
  };

  return (
    <section
      className="renderer-placeholder repository-page"
      aria-labelledby="config-repository-title"
    >
      <header className="page-heading repository-header">
        <div className="renderer-placeholder-mark" aria-hidden="true">
          <Store size={20} />
        </div>
        <div>
          <p className="renderer-eyebrow">CONFIGURATION CATALOG</p>
          <h1 id="config-repository-title">配置仓库</h1>
        </div>
        <button
          type="button"
          disabled={busy_id !== null}
          onClick={() =>
            void run("刷新", () =>
              window.desktopApi.refreshConfigRepository(true),
            )
          }
        >
          刷新官方目录
        </button>
      </header>

      <div className="repository-overview">
        <dl>
          <div>
            <dt>已安装</dt>
            <dd>{repository_counts.installed}</dd>
          </div>
          <div>
            <dt>可更新</dt>
            <dd>{repository_counts.update}</dd>
          </div>
          <div>
            <dt>可安装</dt>
            <dd>{repository_counts.available}</dd>
          </div>
        </dl>
        <div className="repository-status" role="status">
          {message}
        </div>
      </div>
      {(error || state?.sourceError) && (
        <div className="simulation-error" role="alert">
          {error ?? `官方目录：${state?.sourceError}`}
        </div>
      )}

      <section
        className="repository-source official-source"
        aria-labelledby="official-source-title"
      >
        <div className="repository-source-heading">
          <div>
            <span className="source-badge source-installed">官方配置</span>
            <h2 id="official-source-title">官方目录</h2>
          </div>
          <span>{state?.official.length ?? 0} 项</span>
        </div>
        <div className="repository-list">
          {state?.official.length ? (
            state.official.map((config) => {
              const status = repository_status[config.status];
              return (
                <article
                  className="repository-card"
                  data-status={config.status}
                  key={config.id}
                >
                  <div>
                    <div className="repository-card-title">
                      <h3>{config.name}</h3>
                      <span>{status.label}</span>
                    </div>
                    <code>{config.id}</code>
                    <p>{config.description || "暂无说明"}</p>
                  </div>
                  <div className="repository-card-actions">
                    {status.action && (
                      <button
                        type="button"
                        disabled={busy_id !== null}
                        onClick={() => void action(config)}
                      >
                        {busy_id === config.id
                          ? `${status.action}中…`
                          : status.action}
                      </button>
                    )}
                    {config.status !== "available" && (
                      <button
                        className="secondary"
                        type="button"
                        disabled={busy_id !== null}
                        onClick={() =>
                          void run(
                            "卸载",
                            () => window.desktopApi.uninstallConfig(config.id),
                            config.id,
                          )
                        }
                      >
                        卸载
                      </button>
                    )}
                  </div>
                </article>
              );
            })
          ) : (
            <p className="repository-empty">刷新官方目录以查看可安装配置。</p>
          )}
        </div>
      </section>

      <section
        className="repository-source local-source"
        aria-labelledby="local-source-title"
      >
        <div className="repository-source-heading">
          <div>
            <span className="source-badge source-local">本地配置</span>
            <h2 id="local-source-title">开发目录</h2>
          </div>
          <button
            type="button"
            disabled={busy_id !== null}
            onClick={() =>
              void run("选择目录", () =>
                window.desktopApi.selectLocalConfigDirectory(),
              )
            }
          >
            选择本地目录
          </button>
        </div>
        <p
          className="local-directory"
          title={state?.localDirectory ?? undefined}
        >
          {state?.localDirectory ?? "尚未选择目录"}
        </p>
        {state?.localError && (
          <div className="simulation-error" role="alert">
            {state.localError}
          </div>
        )}
        <div className="local-config-list">
          {state?.localConfigs.map((config) => (
            <span key={config.id}>
              <strong>{config.name}</strong>
              <code>{config.id}</code>
            </span>
          ))}
          {state?.localDirectory && state.localConfigs.length === 0 && (
            <p className="repository-empty">目录中没有通过校验的配置。</p>
          )}
        </div>
      </section>
    </section>
  );
}

export default function App() {
  const [active_page, set_active_page] = useState<Page>("simulation");
  const [result_state, set_result_state] = useState<ResultEditorState | null>(
    null,
  );

  const select_result = async (): Promise<boolean> => {
    const selected = await window.desktopApi.selectGsrResult();
    if (!selected) return false;
    set_result_state(selected);
    return true;
  };

  return (
    <div className="renderer-shell">
      <aside className="renderer-sidebar">
        <div className="renderer-brand">
          <span className="renderer-brand-mark" aria-hidden="true" />
        </div>
        <nav aria-label="主导航">
          <p className="renderer-nav-label">工作台</p>
          {pages.map((page) => (
            <button
              key={page.id}
              className="renderer-nav-button"
              aria-current={active_page === page.id ? "page" : undefined}
              aria-label={page.label}
              type="button"
              onClick={() => set_active_page(page.id)}
            >
              {page.icon}
              <span className="renderer-nav-copy">
                <strong>{page.label}</strong>
              </span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="renderer-main">
        <div className="renderer-content">
          <SimulationPage active={active_page === "simulation"} />
          {active_page === "result-editor" ? (
            <ResultEditorPage
              state={result_state}
              on_state={set_result_state}
            />
          ) : active_page === "result-visualize" ? (
            <VisualizeApp
              input={
                result_state
                  ? build_cdf_view_model(
                      result_state.analysis,
                      result_state.display,
                    )
                  : null
              }
              on_select_result={select_result}
            />
          ) : active_page === "config-repository" ? (
            <ConfigRepositoryPage />
          ) : null}
        </div>
      </main>
    </div>
  );
}
