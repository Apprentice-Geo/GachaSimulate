import { AlertTriangle } from "lucide-react";

interface ErrorStateProps {
  message: string;
}

export function ErrorState({ message }: ErrorStateProps) {
  return (
    <div className="state-panel error-panel" data-testid="error-state">
      <AlertTriangle aria-hidden="true" size={34} strokeWidth={1.8} />
      <div>
        <h2>导入失败</h2>
        <pre>{message}</pre>
      </div>
    </div>
  );
}
