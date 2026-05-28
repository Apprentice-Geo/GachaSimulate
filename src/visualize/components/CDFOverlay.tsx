import type { CSSProperties } from "react";
import { useMemo } from "react";
import { usePlotArea, useXAxisScale, useYAxisScale } from "recharts";
import { get_marker_visual } from "./cdf_marker_visuals";
import type { NormalizedVisualizeData } from "../types/visualize_input";
import { CDF_CHART_VIEW_CONFIG } from "../view/cdf_view_config";
import {
  build_curve_path,
  build_marker_views,
} from "../view/cdf_overlay_layout";

interface CDFOverlayProps {
  data: NormalizedVisualizeData;
  animation_key: number;
}

export function CDFOverlay({ data, animation_key }: CDFOverlayProps) {
  const plot_area = usePlotArea();
  const x_scale = useXAxisScale();
  const y_scale = useYAxisScale();
  const marker_views = useMemo(
    () => build_marker_views(data.markers, plot_area, x_scale, y_scale),
    [plot_area, x_scale, y_scale, data.markers],
  );
  const curve_path = useMemo(
    () => build_curve_path(data.chart_points, x_scale, y_scale),
    [data.chart_points, x_scale, y_scale],
  );
  const mean_marker = marker_views.find((view) => view.marker.key === "MEAN");
  const mean_marker_visual = mean_marker
    ? get_marker_visual(mean_marker.marker.weight)
    : null;

  if (!plot_area) {
    return null;
  }

  return (
    <g
      aria-hidden="true"
      className="marker-overlay"
      key={`cdf-markers-${animation_key}`}
    >
      <path
        className="cdf-curve-path"
        d={curve_path}
        data-testid="cdf-curve-path"
        fill="none"
        pathLength={1}
        stroke={CDF_CHART_VIEW_CONFIG.curve_color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={4}
      />
      {mean_marker && (
        <line
          className="mean-horizontal-line"
          stroke={mean_marker.marker.color}
          strokeDasharray="7 9"
          strokeWidth={mean_marker_visual?.stroke_width}
          x1={plot_area.x}
          x2={mean_marker.x}
          y1={mean_marker.y}
          y2={mean_marker.y}
        />
      )}

      {marker_views.map((view, index) => {
        const marker_visual = get_marker_visual(view.marker.weight);

        return (
          <g
            className="marker-group"
            data-marker-key={view.marker.key}
            key={view.marker.key}
            style={
              {
                "--marker-index": index,
                "--marker-label-font-size": `${marker_visual.label_font_size}px`,
                "--marker-label-font-weight": marker_visual.label_font_weight,
                "--marker-label-stroke-width": `${marker_visual.label_stroke_width}px`,
                "--marker-opacity": marker_visual.opacity,
              } as CSSProperties
            }
          >
            <line
              className="marker-line"
              stroke={view.marker.color}
              strokeDasharray="7 9"
              strokeWidth={marker_visual.stroke_width}
              x1={view.x}
              x2={view.x}
              y1={plot_area.y + plot_area.height}
              y2={view.y}
            />
            <circle
              className="marker-point"
              cx={view.x}
              cy={view.y}
              fill={view.marker.color}
              r={marker_visual.point_radius}
            />
            <text
              className="marker-label"
              dominantBaseline={view.dominant_baseline}
              fill={view.marker.color}
              textAnchor={view.text_anchor}
              x={view.label_x}
              y={view.label_y}
            >
              {view.label_text}
            </text>
          </g>
        );
      })}
    </g>
  );
}
