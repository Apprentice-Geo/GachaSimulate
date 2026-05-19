import { Upload } from 'lucide-react';
import { useRef } from 'react';

interface ImportButtonProps {
  compact?: boolean;
  disabled?: boolean;
  on_file_import: (file: File) => void;
}

export function ImportButton({
  compact = false,
  disabled = false,
  on_file_import,
}: ImportButtonProps) {
  const input_ref = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <button
        className={compact ? 'icon-button' : 'command-button'}
        disabled={disabled}
        title="导入 JSON 数据"
        type="button"
        onClick={() => input_ref.current?.click()}
      >
        <Upload aria-hidden="true" size={compact ? 20 : 18} strokeWidth={2} />
        {!compact && <span>导入 JSON</span>}
      </button>
      <input
        ref={input_ref}
        accept="application/json,.json"
        className="visually-hidden"
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            on_file_import(file);
            event.target.value = '';
          }
        }}
      />
    </>
  );
}
