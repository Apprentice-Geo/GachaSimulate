import { WorkbenchIcon } from "./components/WorkbenchIcon";
import {
  FileSpreadsheet,
  PanelsTopLeft,
  Play,
  Settings,
  Store,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { TauriSimulationPage } from "./pages/TauriSimulationPage";
import { TauriConfigRepositoryPage } from "./pages/TauriConfigRepositoryPage";
import { ResultSummaryPage } from "./pages/ResultSummaryPage";
import { TauriSettingsPage } from "./pages/TauriSettingsPage";
import { ResultErrorBoundary } from "./components/ResultErrorBoundary";
import { save_theme, watch_theme, type WorkbenchTheme } from "./theme";
import type { TauriDesktopClient } from "./desktop_client";
import { TauriSimulationController } from "./tauri_simulation_controller";
import { TauriResultSessionController } from "./tauri_result_session_controller";

type Milestone2Page =
  | "simulation"
  | "config-repository"
  | "result-summary"
  | "settings";

const nav_pages: Array<{
  id: Milestone2Page;
  label: string;
  icon: ReactNode;
}> = [
  {
    id: "simulation",
    label: "运行模拟",
    icon: <WorkbenchIcon icon={Play} aria-hidden="true" size={18} />,
  },
  {
    id: "config-repository",
    label: "配置仓库",
    icon: <WorkbenchIcon icon={Store} aria-hidden="true" size={18} />,
  },
  {
    id: "result-summary",
    label: "结果摘要",
    icon: <WorkbenchIcon icon={FileSpreadsheet} aria-hidden="true" size={18} />,
  },
];

/**
 * Milestone 2 Tauri Workbench shell.
 * Visualization canvas, chart preview, inline editing, and export entry points
 * remain intentionally hidden until Milestone 3 integrates the shared Canvas 2D
 * scene and export host.
 */
export function TauriWorkbenchApp({
  client,
  initial_theme,
}: {
  client: TauriDesktopClient;
  initial_theme: WorkbenchTheme;
}) {
  const [theme, set_theme] = useState(initial_theme);
  useLayoutEffect(() => watch_theme(theme), [theme]);
  const [theme_error, set_theme_error] = useState<string | null>(null);
  const change_theme = (next: WorkbenchTheme) => {
    set_theme(next);
    set_theme_error(
      save_theme(next)
        ? null
        : "主题已切换，但无法保存偏好；下次启动可能恢复默认主题。",
    );
  };

  const [active_page, set_active_page] = useState<Milestone2Page>("simulation");
  const [simulation_controller] = useState(
    () => new TauriSimulationController(client),
  );
  const [result_controller] = useState(
    () => new TauriResultSessionController(client),
  );

  useEffect(() => {
    void simulation_controller.connect().catch(() => undefined);
    return () => simulation_controller.disconnect();
  }, [simulation_controller]);

  const result_session = useSyncExternalStore(
    result_controller.subscribe,
    result_controller.get_snapshot,
    result_controller.get_snapshot,
  );

  return (
    <div className="renderer-shell">
      <aside className="renderer-sidebar">
        <nav aria-label="主导航">
          <p className="renderer-nav-label">
            <WorkbenchIcon icon={PanelsTopLeft} aria-hidden="true" size={24} />
            <span>工作台</span>
          </p>
          {nav_pages.map((page) => (
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
        <nav className="renderer-settings-nav" aria-label="应用设置">
          <button
            className="renderer-nav-button"
            aria-current={active_page === "settings" ? "page" : undefined}
            aria-label="设置"
            type="button"
            onClick={() => set_active_page("settings")}
          >
            <WorkbenchIcon icon={Settings} aria-hidden="true" size={18} />
            <span className="renderer-nav-copy">
              <strong>设置</strong>
            </span>
          </button>
        </nav>
      </aside>
      <main className="renderer-main">
        <div className="renderer-content">
          <TauriSimulationPage
            active={active_page === "simulation"}
            client={client}
            controller={simulation_controller}
            result_loading={result_session.loading || result_session.discarding}
            on_view_result={async () => {
              if (!(await result_controller.open_simulation_result())) {
                throw new Error(
                  result_controller.get_snapshot().load_error ??
                    "无法载入本次结果。",
                );
              }
              set_active_page((page) =>
                page === "simulation" ? "result-summary" : page,
              );
            }}
          />
          {active_page === "result-summary" ? (
            <ResultErrorBoundary
              key={result_session.result?.sessionId}
              on_select={result_controller.select_result}
            >
              <ResultSummaryPage
                session={result_session}
                on_select_result={result_controller.select_result}
                on_open_results_directory={() => client.openResultsDirectory()}
              />
            </ResultErrorBoundary>
          ) : active_page === "config-repository" ? (
            <TauriConfigRepositoryPage client={client} />
          ) : active_page === "settings" ? (
            <TauriSettingsPage
              client={client}
              theme={theme}
              on_theme={change_theme}
              theme_error={theme_error}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}
