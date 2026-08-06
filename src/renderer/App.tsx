import { BarChart3, Play, Store } from "lucide-react";
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
  const [error, set_error] = useState<string | null>(null);
  const selected =
    configs.find((config) => config.id === selected_id) ?? configs[0];

  useEffect(() => {
    if (!window.desktopApi) {
      set_error("配置扫描 API 不可用，请从 Electron 启动。");
      set_loading(false);
      return;
    }
    window.desktopApi
      .listInstalledConfigs()
      .then((value) => {
        set_configs(value);
        set_selected_id(value[0]?.id ?? "");
      })
      .catch(() => set_error("配置扫描失败，请检查本地配置目录。"))
      .finally(() => set_loading(false));
  }, []);

  return (
    <section
      className="renderer-placeholder"
      aria-labelledby="simulation-title"
    >
      <div className="renderer-placeholder-mark" aria-hidden="true">
        <Play size={24} />
      </div>
      <p className="renderer-eyebrow">SIMULATION CONSOLE</p>
      <h1 id="simulation-title">运行模拟</h1>
      {loading ? (
        <p>正在扫描已安装配置…</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : configs.length === 0 ? (
        <p>暂无可用配置，请先安装配置。</p>
      ) : (
        <div className="renderer-config-form">
          <label>
            配置
            <select
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
              key={selected?.id}
              defaultValue={selected?.terminations[0]?.file ?? ""}
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
            <VisualizeApp />
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
