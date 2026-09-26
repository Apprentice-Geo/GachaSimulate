import { FolderOpen } from "lucide-react";
import { Button } from "./Button";

export function ResultLoadPanel({
  description,
  loading,
  error,
  status,
  on_select,
}: {
  description: string;
  loading: boolean;
  error?: string | null;
  status?: string;
  on_select: () => void;
}) {
  return (
    <div className="result-load-state" data-testid="result-load-state">
      <div className="instrument-panel result-load-panel">
        <p className="panel-kicker">GSR WORKFLOW</p>
        <h1>载入模拟结果</h1>
        <p>{description}</p>
        <Button type="button" disabled={loading} onClick={on_select}>
          <FolderOpen size={16} aria-hidden="true" />
          {loading ? "正在载入…" : "选择 GSR"}
        </Button>
        {status && (
          <p className="result-load-status" role="status">
            {status}
          </p>
        )}
        {error && (
          <p className="simulation-error result-load-error" role="alert">
            错误：{error}
          </p>
        )}
      </div>
    </div>
  );
}
