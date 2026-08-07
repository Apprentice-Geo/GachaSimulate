import { BarChart3, FolderOpen, Play, Store } from "lucide-react";
import {
  useRef,
  useState,
  useEffect,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import VisualizeApp from "../visualize/App";
import type { InstalledConfig } from "../shared/installed_config";
import type { SimulationRequest, SimulationStatus } from "../shared/simulation";

type Page = "simulation" | "config-store" | "results";

const pages: Array<{
  id: Page;
  label: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    id: "simulation",
    label: "运行模拟",
    description: "配置并运行抽卡模拟",
    icon: <Play aria-hidden="true" size={18} />,
  },
  {
    id: "config-store",
    label: "配置商店",
    description: "浏览可用配置",
    icon: <Store aria-hidden="true" size={18} />,
  },
  {
    id: "results",
    label: "结果可视化",
    description: "查看模拟结果",
    icon: <BarChart3 aria-hidden="true" size={18} />,
  },
];

const SIDEBAR_MIN_WIDTH = 72;
const SIDEBAR_MAX_WIDTH = 320;
const SIDEBAR_LABEL_WIDTH = 176;

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
  const [workers, set_workers] = useState("1");
  const [metric, set_metric] = useState<"draw" | "cost">("draw");
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
    window.desktopApi
      .listInstalledConfigs()
      .then((value) => {
        set_configs(value);
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
      workers: Number(workers),
      metric,
    };
    try {
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
          <div className="simulation-fields">
            <label>
              Seed
              <input
                disabled={busy}
                type="number"
                step="1"
                value={seed}
                onChange={(event) => set_seed(event.target.value)}
              />
            </label>
            <label>
              Workers
              <input
                disabled={busy}
                type="number"
                min="1"
                step="1"
                value={workers}
                onChange={(event) => set_workers(event.target.value)}
              />
            </label>
            <label>
              Metric
              <select
                disabled={busy}
                value={metric}
                onChange={(event) =>
                  set_metric(event.target.value as "draw" | "cost")
                }
              >
                <option value="draw">抽数</option>
                <option value="cost">成本</option>
              </select>
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
            <span>状态：{status}</span>
            {progress && (
              <span>
                进度：{progress.completed}/{progress.total} {progress.unit}
              </span>
            )}
            {result_path && <span>结果：{result_path}</span>}
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

function Placeholder({ page }: { page: "config-store" }) {
  return (
    <section className="renderer-placeholder" aria-labelledby={`${page}-title`}>
      <div className="renderer-placeholder-mark" aria-hidden="true">
        <Store size={24} />
      </div>
      <p className="renderer-eyebrow">CONFIGURATION CATALOG</p>
      <h1 id={`${page}-title`}>配置商店</h1>
      <p>配置商店正在准备中，后续将提供配置浏览与安装。</p>
    </section>
  );
}

export default function App() {
  const [active_page, set_active_page] = useState<Page>("simulation");
  const [sidebar_width, set_sidebar_width] = useState(SIDEBAR_MIN_WIDTH);
  const drag_state = useRef<{
    pointer_id: number;
    start_x: number;
    start_width: number;
  } | null>(null);
  const is_collapsed = sidebar_width < SIDEBAR_LABEL_WIDTH;

  const update_sidebar_width = (width: number) =>
    set_sidebar_width(
      Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)),
    );

  const handle_separator_pointer_down = (
    event: PointerEvent<HTMLDivElement>,
  ) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag_state.current = {
      pointer_id: event.pointerId,
      start_x: event.clientX,
      start_width: sidebar_width,
    };
  };

  const handle_separator_pointer_move = (
    event: PointerEvent<HTMLDivElement>,
  ) => {
    if (drag_state.current?.pointer_id !== event.pointerId) return;
    update_sidebar_width(
      drag_state.current.start_width +
        event.clientX -
        drag_state.current.start_x,
    );
  };

  const handle_separator_pointer_up = (event: PointerEvent<HTMLDivElement>) => {
    if (drag_state.current?.pointer_id !== event.pointerId) return;
    drag_state.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handle_separator_key_down = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      update_sidebar_width(sidebar_width - 8);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      update_sidebar_width(sidebar_width + 8);
    } else if (event.key === "Home") {
      event.preventDefault();
      update_sidebar_width(SIDEBAR_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      update_sidebar_width(SIDEBAR_MAX_WIDTH);
    }
  };

  return (
    <div
      className="renderer-shell"
      style={{ gridTemplateColumns: `${sidebar_width}px 8px minmax(0, 1fr)` }}
    >
      <aside
        className={`renderer-sidebar ${is_collapsed ? "is-collapsed" : "is-expanded"}`}
      >
        <div className="renderer-brand">
          <span className="renderer-brand-mark" aria-hidden="true" />
          <div className="renderer-brand-copy">
            <strong>GachaSimulate</strong>
            <span>DESKTOP CONSOLE</span>
          </div>
        </div>
        <nav aria-label="主导航">
          <p className="renderer-nav-label">工作台</p>
          {pages.map((page) => (
            <button
              key={page.id}
              className="renderer-nav-button"
              aria-current={active_page === page.id ? "page" : undefined}
              aria-label={page.label}
              title={is_collapsed ? page.label : undefined}
              type="button"
              onClick={() => set_active_page(page.id)}
            >
              {page.icon}
              <span className="renderer-nav-copy">
                <strong>{page.label}</strong>
                <small>{page.description}</small>
              </span>
            </button>
          ))}
        </nav>
        <p className="renderer-sidebar-footer">LOCAL SIMULATION TOOLKIT</p>
      </aside>
      <div
        className="renderer-sidebar-separator"
        role="separator"
        aria-label="调整侧栏宽度"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebar_width}
        tabIndex={0}
        onKeyDown={handle_separator_key_down}
        onPointerDown={handle_separator_pointer_down}
        onPointerMove={handle_separator_pointer_move}
        onPointerUp={handle_separator_pointer_up}
        onPointerCancel={handle_separator_pointer_up}
      />
      <main className="renderer-main">
        <div className="renderer-content">
          {active_page === "results" ? (
            <VisualizeApp
              on_select_file={window.desktopApi?.selectVisualizeFile}
            />
          ) : active_page === "simulation" ? (
            <SimulationPage />
          ) : (
            <Placeholder page="config-store" />
          )}
        </div>
      </main>
    </div>
  );
}
