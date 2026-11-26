import type { ReactNode } from "react";
import { use_element_size } from "../hooks/use_element_size";

interface ChartPreviewProps {
  size: { width: number; height: number };
  children: ReactNode;
}

/** Fit one complete chart into the preview scrollport at its design aspect ratio. */
export function ChartPreview({ size, children }: ChartPreviewProps) {
  const [host_ref, available] = use_element_size<HTMLDivElement>();
  const scale = Math.min(available.width / size.width, 1);

  return (
    <div
      className="visualize-scope chart-preview"
      ref={host_ref}
      style={{
        maxWidth: `min(${size.width}px, ${(100 * size.width) / size.height}cqh)`,
        height: size.height * scale,
      }}
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
