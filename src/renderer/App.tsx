import { BarChart3, FolderOpen, Play, Store } from "lucide-react";
import { useState, useEffect, type ReactNode } from "react";
import type { InstalledConfig } from "../shared/installed_config";
import type { DisplayFields, ResultEditorState } from "../shared/result_editor";
import type { VisualizeMetric } from "../visualize/types/visualize_input";
import {
  validate_simulation_request,
  type SimulationRequest,
  type SimulationStatus,
} from "../shared/simulation";

type Page = "simulation" | "config-repository" | "results";

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
    id: "results",
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

function SimulationPage() {
  const [configs, set_configs] = useState<InstalledConfig[]>([]);
  const [selected_id, set_selected_id] = useState("");
  const [loading, set_loading] = useState(true);
  const [config_error, set_config_error] = useState<string | null>(null);
  const [operation_error, set_operation_error] = useState<string | null>(null);
  const [termination, set_termination] = useState("");
  const [target_kind, set_target_kind] = useState<
    "totalRuns" | "targetTotalDraw"
  >("totalRuns");
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
  const selected =
    configs.find((config) => config.id === selected_id) ?? configs[0];

  useEffect(() => {
    if (!window.desktopApi) {
      set_config_error("配置扫描 API 不可用，请从 Electron 启动。");
      set_loading(false);
      return;
    }
    Promise.all([
      window.desktopApi.listInstalledConfigs(),
      window.desktopApi.getLogicalCpuCount(),
    ])
      .then(([value, cpu_count]) => {
        set_configs(value);
        set_logical_cpu_count(cpu_count);
        set_selected_id(value[0]?.id ?? "");
        set_termination(value[0]?.terminations[0]?.file ?? "");
      })
      .catch(() => set_config_error("配置扫描失败，请检查本地配置目录。"))
      .finally(() => set_loading(false));
  }, []);

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
  }, [selected_id, selected]);

  const busy = ["starting", "running", "saving", "cancelling"].includes(status);
  const start = async () => {
    set_operation_error(null);
    set_progress(null);
    set_result_path("");
    const request: SimulationRequest = {
      configId: selected?.id ?? "",
      termination,
      target: {
        kind: target_kind,
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
      className="renderer-placeholder simulation-page"
      aria-labelledby="simulation-title"
    >
      <div className="renderer-placeholder-mark" aria-hidden="true">
        <Play size={24} />
      </div>
      <p className="renderer-eyebrow">SIMULATION CONSOLE</p>
      <h1 id="simulation-title">运行模拟</h1>
      {loading ? (
        <p>正在扫描已安装配置…</p>
      ) : config_error ? (
        <p role="alert">{config_error}</p>
      ) : configs.length === 0 ? (
        <p>暂无可用配置，请先安装配置。</p>
      ) : (
        <div className="renderer-config-form">
          <div className="simulation-primary-fields">
            <div className="simulation-config-fields">
              <label>
                配置
                <select
                  disabled={busy}
                  value={selected?.id ?? ""}
                  onChange={(event) => set_selected_id(event.target.value)}
                >
                  {configs.map((config) => (
                    <option key={config.id} value={config.id}>
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
              <p>{selected?.description}</p>
            </div>
            <fieldset disabled={busy}>
              <legend>目标</legend>
              <label className="simulation-radio">
                <input
                  type="radio"
                  checked={target_kind === "totalRuns"}
                  onChange={() => set_target_kind("totalRuns")}
                />
                固定次数
              </label>
              <label className="simulation-radio">
                <input
                  type="radio"
                  checked={target_kind === "targetTotalDraw"}
                  onChange={() => set_target_kind("targetTotalDraw")}
                />
                累计抽数
              </label>
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

function ResultEditorPage() {
  const [state, set_state] = useState<ResultEditorState | null>(null);
  const [fields, set_fields] = useState<DisplayFields | null>(null);
  const [status, set_status] = useState("请选择 GSR 文件。");
  const [busy, set_busy] = useState(false);
  const [error, set_error] = useState<string | null>(null);

  const apply_state = (next: ResultEditorState) => {
    set_state(next);
    set_fields(next.fields);
  };

  const select = async () => {
    set_busy(true);
    set_error(null);
    set_status("正在分析 draw…");
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

  const switch_metric = async (metric: VisualizeMetric) => {
    set_busy(true);
    set_error(null);
    set_status(`正在分析 ${metric}…`);
    try {
      const next = await window.desktopApi.switchResultMetric(metric);
      apply_state(next);
      set_status("分析完成，尚无未保存更改。");
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
          <label>
            统计维度
            <select
              disabled={busy}
              value={state.metric}
              onChange={(event) =>
                void switch_metric(event.target.value as VisualizeMetric)
              }
            >
              <option value="draw">抽数</option>
              <option value="cost">成本</option>
            </select>
          </label>
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

function Placeholder({ page }: { page: "config-repository" }) {
  return (
    <section className="renderer-placeholder" aria-labelledby={`${page}-title`}>
      <div className="renderer-placeholder-mark" aria-hidden="true">
        <Store size={24} />
      </div>
      <p className="renderer-eyebrow">CONFIGURATION CATALOG</p>
      <h1 id={`${page}-title`}>配置仓库</h1>
      <p>配置仓库正在准备中，后续将提供配置浏览与安装。</p>
    </section>
  );
}

export default function App() {
  const [active_page, set_active_page] = useState<Page>("simulation");

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
          {active_page === "results" ? (
            <ResultEditorPage />
          ) : active_page === "simulation" ? (
            <SimulationPage />
          ) : (
            <Placeholder page="config-repository" />
          )}
        </div>
      </main>
    </div>
  );
}
