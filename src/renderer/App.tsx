import { BarChart3, FilePenLine, FolderOpen, Play, Store } from "lucide-react";
import { useState, useEffect, type ReactNode } from "react";
import type {
  ConfigRepositoryState,
  InstalledConfig,
  RepositoryConfig,
} from "../shared/installed_config";
import type { DisplayFields, ResultEditorState } from "../shared/result_editor";
import { default_result_item, selected_result_item } from "./simulation_items";
import VisualizeApp from "../visualize/App";
import {
  validate_simulation_request,
  type SimulationRequest,
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

function SimulationPage({ active }: { active: boolean }) {
  const [configs, set_configs] = useState<InstalledConfig[]>([]);
  const [selected_key, set_selected_key] = useState("");
  const [loading, set_loading] = useState(true);
  const [config_error, set_config_error] = useState<string | null>(null);
  const [operation_error, set_operation_error] = useState<string | null>(null);
  const [termination, set_termination] = useState("");
  const [result_item, set_result_item] = useState("");
  const [target_value, set_target_value] = useState("10");
  const [seed, set_seed] = useState("0");
  const [threads, set_threads] = useState("1");
  const [logical_cpu_count, set_logical_cpu_count] = useState(1);
  const [status, set_status] = useState<SimulationStatus>("idle");
  const [progress, set_progress] = useState<{
    completed: number;
    total: number;
    unit: string;
  } | null>(null);
  const [result_path, set_result_path] = useState("");
  const key = (config: InstalledConfig) => `${config.source}:${config.id}`;
  const selected =
    configs.find((config) => key(config) === selected_key) ?? configs[0];

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
        if (event?.type === "progress") set_progress(event);
        if (event?.type === "completed") set_result_path(event.result_path);
        if (message) set_operation_error(message);
      },
    );
  }, []);

  useEffect(() => {
    set_termination(selected?.terminations[0]?.file ?? "");
    set_result_item(default_result_item(selected?.items ?? []));
  }, [selected]);

  const busy = ["starting", "running", "saving", "cancelling"].includes(status);
  const start = async () => {
    set_operation_error(null);
    set_progress(null);
    set_result_path("");
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

  return (
    <section
      hidden={!active}
      className="renderer-placeholder simulation-page"
      aria-labelledby="simulation-title"
    >
      <div className="renderer-placeholder-mark" aria-hidden="true">
        <Play size={24} />
      </div>
      <p className="renderer-eyebrow">SIMULATION CONSOLE</p>
      <h1 id="simulation-title">运行模拟</h1>
      {loading ? (
        <p>正在扫描配置…</p>
      ) : config_error ? (
        <p role="alert">{config_error}</p>
      ) : configs.length === 0 ? (
        <p>暂无可用配置，请先安装官方配置或选择本地配置目录。</p>
      ) : (
        <div className="renderer-config-form">
          <div className="simulation-primary-fields">
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
                  {selected?.terminations.map((termination) => (
                    <option key={termination.file} value={termination.file}>
                      {termination.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="simulation-item-picker">
                <label>
                  统计物品 ID
                  <input
                    autoComplete="off"
                    disabled={busy}
                    list="simulation-item-options"
                    value={result_item}
                    onChange={(event) => set_result_item(event.target.value)}
                  />
                  <datalist id="simulation-item-options">
                    {selected?.items.map((item) => (
                      <option key={item.id} value={item.id} />
                    ))}
                  </datalist>
                </label>
                <ul
                  aria-label="当前配置物品"
                  className="simulation-item-panel"
                  tabIndex={0}
                >
                  {selected?.items.map((item) => (
                    <li
                      data-current={result_item.trim() === item.id || undefined}
                      key={item.id}
                    >
                      <code>{item.id}</code>: {item.name}
                    </li>
                  ))}
                </ul>
              </div>
              <p>{selected?.description}</p>
            </div>
            <fieldset disabled={busy}>
              <legend>目标</legend>
              <span>固定次数</span>
              <input
                aria-label="目标值"
                type="number"
                min="1"
                value={target_value}
                onChange={(event) => set_target_value(event.target.value)}
              />
            </fieldset>
          </div>
          <div className="simulation-fields">
            <label>
              随机种子
              <input
                disabled={busy}
                type="number"
                step="1"
                value={seed}
                onChange={(event) => set_seed(event.target.value)}
              />
            </label>
            <label>
              线程数（1–{logical_cpu_count}）
              <input
                disabled={busy}
                type="number"
                min="1"
                max={logical_cpu_count}
                step="1"
                value={threads}
                onChange={(event) => set_threads(event.target.value)}
              />
            </label>
          </div>
          <div className="simulation-actions">
            <button type="button" disabled={busy} onClick={() => void start()}>
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
          <div className="simulation-status" role="status">
            <span>状态：{status_labels[status]}</span>
            {progress && (
              <span>
                进度：{progress.completed}/{progress.total}
              </span>
            )}
            {result_path && (
              <span title={result_path}>
                结果：{result_path.split(/[\\/]/).pop()}
              </span>
            )}
            {result_path && (
              <button type="button" onClick={() => void open_results()}>
                <FolderOpen size={16} aria-hidden="true" />
                打开结果目录
              </button>
            )}
          </div>
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
  const [busy, set_busy] = useState(false);
  const [error, set_error] = useState<string | null>(null);

  const apply_state = (next: ResultEditorState) => {
    on_state(next);
    set_fields(next.fields);
  };

  useEffect(() => set_fields(state?.fields ?? null), [state]);

  const select = async () => {
    set_busy(true);
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
      set_busy(false);
    }
  };

  const save = async () => {
    if (!fields) return;
    set_busy(true);
    set_error(null);
    set_status("正在保存…");
    try {
      apply_state(await window.desktopApi.saveResultFields(fields));
      set_status("已保存。");
    } catch (reason) {
      set_error(reason instanceof Error ? reason.message : String(reason));
      set_status("保存失败，现有 sidecar 未被覆盖。");
    } finally {
      set_busy(false);
    }
  };

  const field = (
    key: keyof DisplayFields,
    label: string,
    multiline = false,
  ) => (
    <label>
      {label}
      {multiline ? (
        <textarea
          disabled={busy}
          value={fields?.[key] ?? ""}
          onBlur={() => void save()}
          onChange={(event) =>
            set_fields((current) =>
              current ? { ...current, [key]: event.target.value } : current,
            )
          }
        />
      ) : (
        <input
          disabled={busy}
          value={fields?.[key] ?? ""}
          onBlur={() => void save()}
          onChange={(event) =>
            set_fields((current) =>
              current ? { ...current, [key]: event.target.value } : current,
            )
          }
        />
      )}
    </label>
  );

  return (
    <section
      className="renderer-placeholder result-editor"
      aria-labelledby="result-title"
    >
      <div className="renderer-placeholder-mark" aria-hidden="true">
        <BarChart3 size={24} />
      </div>
      <p className="renderer-eyebrow">GSR RESULT EDITOR</p>
      <h1 id="result-title">结果展示信息</h1>
      <button type="button" disabled={busy} onClick={() => void select()}>
        选择 GSR
      </button>
      {state && fields && (
        <div className="result-editor-form">
          <p title={state.path}>文件：{state.filename}</p>
          <p>结果指标：{state.input.result_item.name}</p>
          {field("title", "标题")}
          {field("target", "目标")}
          {field("note", "说明", true)}
          {field("price", "价格")}
          {field("unit", "单位")}
          <p title={state.sidecar_path}>
            sidecar：{state.sidecar_path.split(/[\\/]/).pop()}
          </p>
        </div>
      )}
      <p role="status">{status}</p>
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
    set_message(`${label}中…`);
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
        set_message("本机配置状态已读取。");
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

  return (
    <section
      className="renderer-placeholder repository-page"
      aria-labelledby="config-repository-title"
    >
      <header className="repository-header">
        <div>
          <div className="renderer-placeholder-mark" aria-hidden="true">
            <Store size={24} />
          </div>
          <p className="renderer-eyebrow">CONFIGURATION CATALOG</p>
          <h1 id="config-repository-title">配置仓库</h1>
        </div>
        <button
          type="button"
          disabled={busy_id !== null}
          onClick={() =>
            void run("刷新", () => window.desktopApi.refreshConfigRepository())
          }
        >
          刷新官方目录
        </button>
      </header>

      <div className="repository-status" role="status">
        {message}
      </div>
      {(error || state?.sourceError) && (
        <div className="simulation-error" role="alert">
          {error ?? `官方目录：${state?.sourceError}`}
        </div>
      )}

      <section
        className="repository-source"
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
              input={result_state?.input ?? null}
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
