import { FileJson } from "lucide-react";

export function EmptyState() {
  return (
    <div className="state-panel" data-testid="empty-state">
      <FileJson aria-hidden="true" size={34} strokeWidth={1.8} />
      <div>
        <h2>等待选择结果</h2>
        <p>请选择 GSR 结果文件。</p>
      </div>
    </div>
  );
}
