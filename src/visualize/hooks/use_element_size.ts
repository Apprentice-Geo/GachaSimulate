import { useLayoutEffect, useRef, useState } from "react";

interface ElementSize {
  width: number;
  height: number;
}

export function use_element_size<T extends HTMLElement>() {
  const element_ref = useRef<T | null>(null);
  const [size, set_size] = useState<ElementSize>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = element_ref.current;
    if (!element) {
      return undefined;
    }

    const update_size = () => {
      const rect = element.getBoundingClientRect();
      set_size({
        width: rect.width,
        height: rect.height,
      });
    };

    const observer = new ResizeObserver(([entry]) => {
      set_size({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    update_size();
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [element_ref, size] as const;
}
