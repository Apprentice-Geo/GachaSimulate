import type { CDFMarker } from "../types/visualize_input";

interface CDFMarkerVisual {
  opacity: number;
  stroke_width: number;
  point_radius: number;
  label_font_size: number;
  label_font_weight: number;
  label_stroke_width: number;
}

// 集中控制CDF标注的样式
export const MARKER_VISUALS: Record<CDFMarker["weight"], CDFMarkerVisual> = {
  faint: {
    // MIN P5
    opacity: 0.85, // 不透明度
    stroke_width: 4, // 线条宽度
    point_radius: 11, // 标注点的半径
    label_font_size: 30, // 标签字体大小
    label_font_weight: 700, // 标签字体粗细
    label_stroke_width: 5, // 标签描边宽度
  },
  normal: {
    // P25 P75
    opacity: 0.9,
    stroke_width: 4.66,
    point_radius: 11,
    label_font_size: 36,
    label_font_weight: 700,
    label_stroke_width: 5.5,
  },
  strong: {
    // MEAN P95 MAX
    opacity: 0.95,
    stroke_width: 5.32,
    point_radius: 13,
    label_font_size: 42,
    label_font_weight: 700,
    label_stroke_width: 6,
  },
  primary: {
    // P50
    opacity: 0.95,
    stroke_width: 6,
    point_radius: 16,
    label_font_size: 48,
    label_font_weight: 800,
    label_stroke_width: 6,
  },
};

export function get_marker_visual(
  weight: CDFMarker["weight"],
): CDFMarkerVisual {
  return MARKER_VISUALS[weight];
}
