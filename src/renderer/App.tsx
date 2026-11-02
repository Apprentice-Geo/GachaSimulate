import { WorkbenchIcon } from "./components/WorkbenchIcon";
import {
  BarChart3,
  FilePenLine,
  PanelsTopLeft,
  Play,
  Settings,
  Store,
} from "lucide-react";
import { useState, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ExportWorkflow } from "./ExportWorkflow";
import { SimulationPage } from "./pages/SimulationPage";
import { ResultEditorPage } from "./pages/ResultEditorPage";
import { ConfigRepositoryPage } from "./pages/ConfigRepositoryPage";
import { ResultVisualizePage } from "./pages/ResultVisualizePage";
import { SettingsPage } from "./pages/SettingsPage";
import { save_theme, type WorkbenchTheme } from "./theme";
import { ResultSessionController } from "./result_session_controller";
import { ResultErrorBoundary } from "./components/ResultErrorBoundary";

type Page =
  | "simulation"
  | "config-repository"
  | "result-editor"
  | "result-visualize"
  | "settings";

const pages: Array<{
  id: Page;
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
    id: "result-editor",
    label: "结果编辑",
    icon: <WorkbenchIcon icon={FilePenLine} aria-hidden="true" size={18} />,
  },
  {
    id: "result-visualize",
    label: "结果可视化",
    icon: <WorkbenchIcon icon={BarChart3} aria-hidden="true" size={18} />,
  },
];

export default function App() {
  const [theme, set_theme] = useState<WorkbenchTheme>(() =>
    document.body.dataset.workbenchTheme === "dark" ? "dark" : "light",
  );
  const [theme_error, set_theme_error] = useState<string | null>(null);
  const change_theme = (next: WorkbenchTheme) => {
    set_theme(next);
    set_theme_error(
      save_theme(next)
        ? null
        : "主题已切换，但无法保存偏好；下次启动可能恢复默认主题。",
    );
  };
  const [visualize_actions_host, set_visualize_actions_host] =
    useState<HTMLDivElement | null>(null);
  const [active_page, set_active_page] = useState<Page>("simulation");
  const [result_controller] = useState(
    () => new ResultSessionController(window.desktopApi),
  );
  const result_session = useSyncExternalStore(
    result_controller.subscribe,
    result_controller.get_snapshot,
  );
  const result_state = result_session.result;
  const select_result = result_controller.select_result;
  const visualize_input = result_session.model;
  const export_context = useMemo(
    () =>
      result_state
        ? {
            session_id: result_state.session_id,
            default_base_name: result_state.filename.replace(/\.gsr$/i, ""),
          }
        : null,
    [result_state],
  );

  return (
    <ExportWorkflow
      context={export_context}
      before_prepare={result_controller.wait_for_saves}
    >
      {({ active: export_active, open: open_export }) => (
        <div className="renderer-shell">
          <aside className="renderer-sidebar">
            <nav aria-label="主导航">
              <p className="renderer-nav-label">
                <WorkbenchIcon
                  icon={PanelsTopLeft}
                  aria-hidden="true"
                  size={24}
                />
                <span>工作台</span>
              </p>
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
              <div ref={set_visualize_actions_host} />
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
              <SimulationPage active={active_page === "simulation"} />
              {active_page === "result-editor" ? (
                <ResultErrorBoundary
                  key={result_state?.session_id}
                  on_select={select_result}
                >
                  <ResultEditorPage
                    session={result_session}
                    controller={result_controller}
                  />
                </ResultErrorBoundary>
              ) : active_page === "result-visualize" ? (
                <ResultErrorBoundary
                  key={result_state?.session_id}
                  on_select={select_result}
                >
                  <ResultVisualizePage
                    actions_host={visualize_actions_host}
                    input={visualize_input}
                    session={result_session}
                    on_select_result={select_result}
                    export_active={export_active}
                    on_export={open_export}
                  />
                </ResultErrorBoundary>
              ) : active_page === "config-repository" ? (
                <ConfigRepositoryPage />
              ) : active_page === "settings" ? (
                <SettingsPage
                  theme={theme}
                  on_theme={change_theme}
                  theme_error={theme_error}
                />
              ) : null}
            </div>
          </main>
        </div>
      )}
    </ExportWorkflow>
  );
}
