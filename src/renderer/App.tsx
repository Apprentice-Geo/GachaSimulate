import { BarChart3, FilePenLine, Play, Store } from "lucide-react";
import { useCallback, useState, useMemo, type ReactNode } from "react";
import type { ResultEditorState } from "../shared/result_editor";
import { ExportWorkflow } from "./ExportWorkflow";
import { SimulationPage } from "./pages/SimulationPage";
import { ResultEditorPage } from "./pages/ResultEditorPage";
import { ConfigRepositoryPage } from "./pages/ConfigRepositoryPage";
import VisualizeApp from "../visualize/App";
import { build_cdf_view_model } from "../visualize/view/cdf_view_model";

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

export default function App() {
  const [active_page, set_active_page] = useState<Page>("simulation");
  const [result_state, set_result_state] = useState<ResultEditorState | null>(
    null,
  );

  const select_result = useCallback(async (): Promise<boolean> => {
    const selected = await window.desktopApi.selectGsrResult();
    if (!selected) return false;
    set_result_state(selected);
    return true;
  }, []);
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
  const visualize_input = useMemo(
    () =>
      result_state
        ? build_cdf_view_model(result_state.analysis, result_state.display)
        : null,
    [result_state?.analysis, result_state?.display],
  );

  return (
    <ExportWorkflow context={export_context}>
      {({ active: export_active, open: open_export }) => (
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
                  input={visualize_input}
                  on_select_result={select_result}
                  export_active={export_active}
                  export_available={result_state !== null}
                  on_export={open_export}
                />
              ) : active_page === "config-repository" ? (
                <ConfigRepositoryPage />
              ) : null}
            </div>
          </main>
        </div>
      )}
    </ExportWorkflow>
  );
}
