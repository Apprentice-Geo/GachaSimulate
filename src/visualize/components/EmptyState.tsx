import { FileJson } from "lucide-react";

export function EmptyState({ desktop = false }: { desktop?: boolean }) {
  return (
    <div className="state-panel" data-testid="empty-state">
      <FileJson aria-hidden="true" size={34} strokeWidth={1.8} />
      <div>
        <h2>等待选择结果</h2>
        <p>
          {desktop
            ? "请选择 GSR 结果文件。"
            : "请选择模拟器导出的 JSON 文件，或使用 URL 参数指定项目内输入路径。"}
        </p>
      </div>
    </div>
  );
}
