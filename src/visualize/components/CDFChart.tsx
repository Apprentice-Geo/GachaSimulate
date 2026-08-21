import type { CSSProperties } from "react";
import { CartesianGrid, LineChart, XAxis, YAxis } from "recharts";
import { CDFOverlay } from "./CDFOverlay";
import type { CDFViewModel } from "../types/cdf";
import { CDF_CHART_VIEW_CONFIG } from "../view/cdf_view_config";
import { use_element_size } from "../hooks/use_element_size";
import type { AnimationProgress } from "../animation/progress";

const CHART_MARGIN = {
  top: 116,
  right: 72,
  bottom: 68,
  left: 96,
}; // 控制 Recharts 图表内容相对外层 SVG 的留白
const COMPACT_CHART_MARGIN = {
  top: 28,
  right: 24,
  bottom: 34,
  left: 44,
};
const Y_AXIS_WIDTH = 108; //  Y 轴宽度
const COMPACT_Y_AXIS_WIDTH = 44;
const X_AXIS_HEIGHT = 104; //  X 轴高度
const COMPACT_X_AXIS_HEIGHT = 40;
const Y_CDF_AXIS_TICKS = [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1];
interface CDFChartProps {
  data: CDFViewModel;
  animation_progress: AnimationProgress;
  compact?: boolean;
  fixed_size?: { width: number; height: number };
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
  data,
  animation_progress,
  compact = false,
  fixed_size,
  style,
}: CDFChartProps) {
  const [chart_ref, chart_size] = use_element_size<HTMLDivElement>();
  const render_size = fixed_size ?? chart_size;
  const margin = compact ? COMPACT_CHART_MARGIN : CHART_MARGIN;
  const y_axis_width = compact ? COMPACT_Y_AXIS_WIDTH : Y_AXIS_WIDTH;
  const x_axis_height = compact ? COMPACT_X_AXIS_HEIGHT : X_AXIS_HEIGHT;

  return (
    <div
      ref={chart_ref}
      className={`cdf-chart-shell${compact ? " cdf-chart-shell-compact" : ""}`}
      data-testid="cdf-chart"
      style={style}
    >
      {/* Keep the Y-axis title outside Recharts so its rotated position stays stable in the responsive shell. */}
      <div className="y-axis-title">累计占比</div>
      {render_size.width > 0 && render_size.height > 0 && (
        <LineChart
          data={data.chart_points}
          height={render_size.height}
          margin={margin}
          syncId="cdf-chart"
          width={render_size.width}
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
              fontSize: compact ? 14 : 32,
            }}
            tickFormatter={format_draw}
            height={x_axis_height}
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
              fontSize: compact ? 13 : 28,
            }}
            tickFormatter={format_percent}
            ticks={Y_CDF_AXIS_TICKS}
            tickMargin={10}
            tickLine={{ stroke: CDF_CHART_VIEW_CONFIG.axis_tick_color }}
            type="number"
            width={y_axis_width}
          />
          <CDFOverlay
            compact={compact}
            data={data}
            animation_progress={animation_progress}
          />
        </LineChart>
      )}
    </div>
  );
}
