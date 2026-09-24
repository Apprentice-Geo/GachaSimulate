import { useState } from "react";
import { createPortal } from "react-dom";
import VisualizeApp from "../../visualize/App";
import type { CDFViewModel } from "../../visualize/types/cdf";
import { ResultLoadPanel } from "../components/ResultLoadPanel";
import { Button } from "../components/Button";

export function ResultVisualizePage({
  input,
  on_select_result,
  on_export,
  export_active,
  actions_host,
}: {
  input: CDFViewModel | null;
  on_select_result: () => Promise<boolean>;
  on_export: () => void;
  export_active: boolean;
  actions_host: HTMLElement | null;
}) {
  const [loading, set_loading] = useState(false);
  const [status, set_status] = useState<string | undefined>();
  const [error, set_error] = useState<string | null>(null);

  const select = async (): Promise<boolean> => {
    set_loading(true);
    set_error(null);
    set_status("正在分析…");
    try {
      const selected = await on_select_result();
      set_status(selected ? undefined : "未选择文件。");
      return selected;
    } catch (reason) {
      set_error(reason instanceof Error ? reason.message : String(reason));
      set_status("分析失败。");
      return false;
    } finally {
      set_loading(false);
    }
  };

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
                  aria-description={loading ? "正在读取结果。" : undefined}
                  onClick={() => void select()}
                >
                  更换结果
                </Button>
                <Button
                  variant="ghost"
                  disabled={is_animating || loading || export_active}
                  aria-description={
                    is_animating
                      ? "动画正在播放。"
                      : loading
                        ? "正在读取结果。"
                        : undefined
                  }
                  onClick={replay}
                >
                  重播动画
                </Button>
                <Button
                  variant="ghost"
                  disabled={loading || export_active}
                  aria-label={
                    export_active
                      ? "导出素材：已有导出流程正在进行。"
                      : loading
                        ? "导出素材：正在读取结果。"
                        : undefined
                  }
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
