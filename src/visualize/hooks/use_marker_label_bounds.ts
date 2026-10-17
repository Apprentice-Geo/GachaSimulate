import { useLayoutEffect, useRef, useState } from "react";
import type {
  ChartPlotArea,
  MarkerLabelBoundsByKey,
} from "../view/cdf_overlay_layout";
import type { CDFMarker, MarkerKey } from "../types/cdf";

/** Measure in SVG design coordinates, independently of preview/host scaling. */
export function use_marker_label_bounds(
  markers: readonly CDFMarker[],
  plot_area: ChartPlotArea | undefined,
) {
  const ref = useRef<SVGGElement>(null);
  const [bounds, set_bounds] = useState<MarkerLabelBoundsByKey>({});

  useLayoutEffect(() => {
    let disposed = false;
    const measure = () => {
      if (disposed || !ref.current) return;
      const next: MarkerLabelBoundsByKey = {};
      for (const label of ref.current.querySelectorAll<SVGTextElement>(
        ".marker-label",
      )) {
        const key = label.parentElement!.getAttribute(
          "data-marker-key",
        ) as MarkerKey;
        const box = label.getBBox();
        const stroke = parseFloat(getComputedStyle(label).strokeWidth) / 2;
        next[key] = {
          x: box.x - label.x.baseVal[0].value - stroke,
          y: box.y - label.y.baseVal[0].value - stroke,
          width: box.width + stroke * 2,
          height: box.height + stroke * 2,
        };
      }
      set_bounds((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    measure();
    void document.fonts.ready.then(measure);
    return () => {
      disposed = true;
    };
  }, [markers, plot_area]);

  return { ref, bounds };
}
