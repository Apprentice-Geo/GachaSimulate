import type { CSSProperties, ReactNode } from "react";
import { use_element_size } from "../hooks/use_element_size";

interface ChartPreviewProps {
  size: { width: number; height: number };
  children: ReactNode;
}

/** Keep design coordinates intact; only the host adapts to available width. */
export function ChartPreview({ size, children }: ChartPreviewProps) {
  const [host_ref, available] = use_element_size<HTMLDivElement>();
  const scale = Math.min(available.width / size.width, 1);

  return (
    <div
      className="visualize-scope chart-preview"
      ref={host_ref}
      style={
        {
          height: size.height * scale,
          "--preview-rendered-width": `${size.width * scale}px`,
        } as CSSProperties
      }
    >
      <div
        className="chart-preview-content"
        style={{
          width: size.width,
          height: size.height,
          transform: `scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
