import type { CSSProperties } from "react";
import { CartesianGrid, LineChart, XAxis, YAxis } from "recharts";
import { CDFOverlay } from "./CDFOverlay";
import type { CDFViewModel } from "../types/cdf";
import { CDF_CHART_VIEW_CONFIG } from "../view/cdf_view_config";
import type { AnimationProgress } from "../animation/progress";

const CHART_MARGIN = {
  top: 116,
  right: 72,
  bottom: 68,
  left: 96,
}; // 控制 Recharts 图表内容相对外层 SVG 的留白
const Y_AXIS_WIDTH = 108;
const X_AXIS_HEIGHT = 104;
const Y_CDF_AXIS_TICKS = [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1];
interface CDFChartProps {
  size: { width: number; height: number };
  data: CDFViewModel;
  animation_progress: AnimationProgress;
  style?: CSSProperties;
}

function format_percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function format_draw(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(value);
}

export function CDFChart({
  size,
  data,
  animation_progress,
  style,
}: CDFChartProps) {
  return (
    <div
      className="cdf-chart-shell"
      data-testid="cdf-chart"
      style={{ ...style, width: size.width, height: size.height }}
    >
      <svg
        className="cdf-axis-titles"
        width={size.width}
        height={size.height}
        style={{
          opacity: animation_progress.chart_surface.opacity,
          transform: `translateY(${animation_progress.chart_surface.translate_y}px)`,
        }}
      >
        <text
          className="y-axis-title"
          x={80}
          y={size.height / 2}
          textAnchor="middle"
          dominantBaseline="central"
          transform={`rotate(-90 80 ${size.height / 2})`}
        >
          累计占比
        </text>
      </svg>
      {size.width > 0 && size.height > 0 && (
        <LineChart
          data={data.chart_points}
          height={size.height}
          margin={CHART_MARGIN}
          syncId="cdf-chart"
          width={size.width}
          style={{
            opacity: animation_progress.chart_surface.opacity,
            transform: `translateY(${animation_progress.chart_surface.translate_y}px)`,
          }}
        >
          <CartesianGrid
            stroke={CDF_CHART_VIEW_CONFIG.grid_color}
            strokeDasharray="4 10"
            vertical
          />
          <XAxis
            allowDecimals={false}
            dataKey="draw"
            domain={[0, data.x_domain_max]}
            stroke={CDF_CHART_VIEW_CONFIG.axis_color}
            tick={{
              fill: CDF_CHART_VIEW_CONFIG.x_tick_color,
              fontSize: 32,
            }}
            tickFormatter={format_draw}
            height={X_AXIS_HEIGHT}
            label={{
              value: data.axis_title,
              position: "insideBottom",
              offset: -5,
              className: "axis-title",
            }}
            tickLine={{ stroke: CDF_CHART_VIEW_CONFIG.axis_tick_color }}
            type="number"
          />
          <YAxis
            dataKey="cumulative"
            domain={[0, 1]}
            stroke={CDF_CHART_VIEW_CONFIG.axis_color}
            tick={{
              fill: CDF_CHART_VIEW_CONFIG.y_tick_color,
              fontSize: 28,
            }}
            tickFormatter={format_percent}
            ticks={Y_CDF_AXIS_TICKS}
            tickMargin={10}
            tickLine={{ stroke: CDF_CHART_VIEW_CONFIG.axis_tick_color }}
            type="number"
            width={Y_AXIS_WIDTH}
          />
          <CDFOverlay data={data} animation_progress={animation_progress} />
        </LineChart>
      )}
    </div>
  );
}
