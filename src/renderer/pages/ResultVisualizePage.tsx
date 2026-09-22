import { useState } from "react";
import VisualizeApp from "../../visualize/App";
import type { CDFViewModel } from "../../visualize/types/cdf";
import { ResultLoadPanel } from "../components/ResultLoadPanel";

export function ResultVisualizePage({
  input,
  on_select_result,
  on_export,
  export_active,
}: {
  input: CDFViewModel | null;
  on_select_result: () => Promise<boolean>;
  on_export: () => void;
  export_active: boolean;
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
      <VisualizeApp
        input={input}
        on_select_result={select}
        export_active={export_active}
        export_available
        on_export={on_export}
      />
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
