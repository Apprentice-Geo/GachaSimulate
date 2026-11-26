import type { CSSProperties } from "react";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../constants";

export const CANVAS_STYLE = {
  "--canvas-width": `${CANVAS_WIDTH}px`,
  "--canvas-height": `${CANVAS_HEIGHT}px`,
};

// Shared design coordinates for the scene and its chart previews.
export const CDF_CHART_SIZE = { width: 2800, height: 1400 } as const;

// Leave room for a centered horizontal tick label at the right edge.
export const CDF_CHART_MARGIN = { top: 180, right: 108, bottom: 68, left: 96 };
export const CDF_X_AXIS_HEIGHT = 104;
export const CDF_Y_AXIS_WIDTH = 108;
export const CDF_X_AXIS_TITLE_STYLE = {
  insetInlineStart: CDF_CHART_MARGIN.left + CDF_Y_AXIS_WIDTH,
  insetInlineEnd: CDF_CHART_MARGIN.right,
  bottom: CDF_CHART_MARGIN.bottom,
} satisfies CSSProperties;
export const CDF_PLOT_SIZE = {
  width:
    CDF_CHART_SIZE.width -
    CDF_CHART_MARGIN.left -
    CDF_CHART_MARGIN.right -
    CDF_Y_AXIS_WIDTH,
  height:
    CDF_CHART_SIZE.height -
    CDF_CHART_MARGIN.top -
    CDF_CHART_MARGIN.bottom -
    CDF_X_AXIS_HEIGHT,
};

// Keep the chart heading above the space available to marker labels.
export const CDF_MARKER_LABEL_TOP = 96;

export const SCENE_LAYOUT_STYLE = {
  ...CANVAS_STYLE,
  "--chart-width": `${CDF_CHART_SIZE.width}px`,
  "--chart-height": `${CDF_CHART_SIZE.height}px`,
} as CSSProperties;
