import type { ComponentProps } from "react";

// Keep a native wrapping label so inputs, selects and textareas retain their
// accessible names and click-to-focus behavior without generated IDs.
export function Field({ className = "", ...props }: ComponentProps<"label">) {
  return <label {...props} className={`field ${className}`} />;
}
