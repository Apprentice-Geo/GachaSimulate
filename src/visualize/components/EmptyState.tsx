import { FileJson } from "lucide-react";

export function EmptyState() {
  return (
    <div className="state-panel" data-testid="empty-state">
      <FileJson aria-hidden="true" size={34} strokeWidth={1.8} />
      <div>
        <h2>等待导入数据</h2>
        <p>请选择模拟器导出的 JSON 文件，或使用 URL 参数指定项目内输入路径。</p>
      </div>
    </div>
  );
}
