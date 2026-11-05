import { createPortal } from "react-dom";
import VisualizeApp from "../../visualize/App";
import type { CDFViewModel } from "../../visualize/types/cdf";
import { ResultLoadPanel } from "../components/ResultLoadPanel";
import { Button } from "../components/Button";
import type { ResultSessionState } from "../result_session_controller";

export function ResultVisualizePage({
  input,
  on_select_result,
  on_export,
  export_active,
  actions_host,
  session,
}: {
  input: CDFViewModel | null;
  session: ResultSessionState;
  on_select_result: () => Promise<boolean>;
  on_export: () => void;
  export_active: boolean;
  actions_host: HTMLElement | null;
}) {
  const { loading, load_error: error, load_status: status } = session;
  const select = on_select_result;

  if (input) {
    return (
      <section className="result-visualize-loaded">
        <VisualizeApp
          input={input}
          render_controls={({ replay, is_animating }) =>
            actions_host &&
            createPortal(
              <div
                className="visualize-sidebar-actions"
                role="group"
                aria-label="可视化操作"
              >
                <Button
                  variant="ghost"
                  disabled={loading || export_active}
                  onClick={() => void select()}
                >
                  更换结果
                </Button>
                <Button
                  variant="ghost"
                  disabled={is_animating || loading || export_active}
                  onClick={replay}
                >
                  重播动画
                </Button>
                <Button
                  variant="ghost"
                  disabled={loading || export_active}
                  onClick={on_export}
                >
                  导出素材
                </Button>
              </div>,
              actions_host,
            )
          }
        />
        {(status || error) && (
          <div className="result-visualize-feedback">
            {status && <p role="status">{status}</p>}
            {error && (
              <p className="simulation-error" role="alert">
                错误：{error}
              </p>
            )}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="renderer-placeholder result-load-page">
      <ResultLoadPanel
        description="选择 GSR 文件并完成分析后，即可查看 CDF 曲线、核心统计量和达成路径分布。"
        loading={loading}
        error={error}
        status={status}
        on_select={() => void select()}
      />
    </section>
  );
}
