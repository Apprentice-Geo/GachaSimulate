import { AlertTriangle } from "lucide-react";
import { ImportButton } from "./ImportButton";

interface ErrorStateProps {
  message: string;
  on_file_import?: (file: File) => void;
}

export function ErrorState({ message, on_file_import }: ErrorStateProps) {
  return (
    <div className="state-panel error-panel" data-testid="error-state">
      <AlertTriangle aria-hidden="true" size={34} strokeWidth={1.8} />
      <div>
        <h2>导入失败</h2>
        <pre>{message}</pre>
        {on_file_import && <ImportButton on_file_import={on_file_import} />}
      </div>
    </div>
  );
}
