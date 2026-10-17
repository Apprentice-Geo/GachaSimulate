import type { CSSProperties } from "react";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../constants";

export const CANVAS_STYLE = {
  "--canvas-width": `${CANVAS_WIDTH}px`,
  "--canvas-height": `${CANVAS_HEIGHT}px`,
};

// Shared design coordinates for the scene and its chart previews.
export const CDF_CHART_SIZE = { width: 2800, height: 1400 } as const;

export const SCENE_LAYOUT_STYLE = {
  ...CANVAS_STYLE,
  "--chart-width": `${CDF_CHART_SIZE.width}px`,
  "--chart-height": `${CDF_CHART_SIZE.height}px`,
} as CSSProperties;
