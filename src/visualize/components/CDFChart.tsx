import type { CSSProperties } from 'react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  LineChart,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
  XAxis,
  YAxis,
} from 'recharts';
import type { ScaleFunction } from 'recharts';
import { get_marker_visual } from './cdf_marker_visuals';
import type {
  CDFMarker,
  NormalizedVisualizeData,
} from '../types/visualize_input';
import {
  CDF_CHART_VIEW_CONFIG,
  CDF_MARKER_VIEW_CONFIG,
} from '../view/cdf_view_config';

const CHART_MARGIN = {
  top: 58,
  right: 36,
  bottom: 34,
  left: 48,
};// 控制 Recharts 图表内容相对外层 SVG 的留白
const Y_AXIS_WIDTH = 54; //  Y 轴宽度
const X_AXIS_HEIGHT = 52;//  X 轴高度
const Y_CDF_AXIS_TICKS = [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1];
interface CDFChartProps {
  data: NormalizedVisualizeData;
  animation_key: number;
  is_animating: boolean;
}

interface CDFOverlayProps {
  data: NormalizedVisualizeData;
  animation_key: number;
}

interface ElementSize {
  width: number;
  height: number;
}// 图表容器实际尺寸

interface MarkerView {
  marker: CDFMarker;
  x: number;
  y: number;
  label_x: number;
  label_y: number;
  // 文字横向对齐方式
  text_anchor: 'start' | 'middle' | 'end';
  // 文字纵向对齐方式
  dominant_baseline: 'auto' | 'hanging' | 'middle' | 'text-after-edge';
  label_text: string;
}

interface PlotBox {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface ChartPlotArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

function use_element_size<T extends HTMLElement>() {
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

function format_percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function format_draw(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 0,
  }).format(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function estimate_label_width(label: string): number {
  return label.length * 9.6;
}

function clamp_label_x(
  x: number,
  text_anchor: MarkerView['text_anchor'],
  label_text: string,
  plot_box: PlotBox,
): number {
  const label_width = estimate_label_width(label_text);
  if (text_anchor === 'end') {
    return clamp(x, plot_box.left + label_width, plot_box.right - 4);
  }
  if (text_anchor === 'start') {
    return clamp(x, plot_box.left + 4, plot_box.right - label_width);
  }
  return clamp(
    x,
    plot_box.left + label_width / 2,
    plot_box.right - label_width / 2,
  );
}

function build_marker_views(
  markers: CDFMarker[],
  plot_area: ChartPlotArea | undefined,
  x_scale: ScaleFunction | undefined,
  y_scale: ScaleFunction | undefined,
): MarkerView[] {
  if (!plot_area || !x_scale || !y_scale) {
    return [];
  }

  const plot_box: PlotBox = {
    left: plot_area.x,
    top: plot_area.y,
    width: plot_area.width,
    height: plot_area.height,
    right: plot_area.x + plot_area.width,
    bottom: plot_area.y + plot_area.height,
  };
  const p50 = markers.find((marker) => marker.key === 'P50');
  const mean = markers.find((marker) => marker.key === 'MEAN');
  const p50_is_greater_than_mean = (p50?.draw ?? 0) > (mean?.draw ?? 0);

  const views = markers.flatMap((marker) => {
    const x = x_scale(marker.draw);
    const marker_level =
      CDF_MARKER_VIEW_CONFIG[marker.key].quantile_level ?? marker.level;
    const y = y_scale(clamp(marker_level, 0, 1));
    if (x === undefined || y === undefined) {
      return [];
    }

    // 默认标签位置在标注点的左上方
    let label_x = x - 8, label_y = y - 10;
    let text_anchor: MarkerView['text_anchor'] = 'end';
    let dominant_baseline: MarkerView['dominant_baseline'] = 'auto';
    let label_text = marker.label;

    if (marker.key === 'MEAN') {
      label_x = x - 14;
      label_y = y;
      text_anchor = 'end';
      dominant_baseline = p50_is_greater_than_mean
        ? 'hanging'
        : 'text-after-edge';
      label_text = 'MEAN ';
    }

    if (marker.key === 'MAX') {
      label_x = x - 12;
      label_y = y - 10;
      text_anchor = 'end';
      dominant_baseline = 'text-after-edge';
      label_text = 'MAX ';
    }

    if (marker.key === 'P50') {
      label_x = x - 14;
      label_y = y;
      text_anchor = 'end';
      dominant_baseline = p50_is_greater_than_mean
        ? 'text-after-edge'
        : 'hanging';
      label_text = 'P50 ';
    }

    return {
      marker,
      x,
      y,
      label_x,
      label_y,
      text_anchor,
      dominant_baseline,
      label_text,
    };
  });

  const sorted_views = [...views].sort((a, b) => a.label_y - b.label_y);
  sorted_views.forEach((view, index) => {
    if (index === 0) {
      return;
    }

    const previous_view = sorted_views[index - 1];
    const is_neighboring =
      Math.abs(view.x - previous_view.x) < 76 &&
      Math.abs(view.label_y - previous_view.label_y) < 16;
    if (is_neighboring) {
      view.label_y += index % 2 === 0 ? 12 : -12;
    }
  });

  return views.map((view) => ({
    ...view,
    label_x: clamp_label_x(
      view.label_x,
      view.text_anchor,
      view.label_text,
      plot_box,
    ),
    label_y: clamp(view.label_y, 24, plot_box.bottom - 8),
  }));
}

function build_curve_path(
  data: NormalizedVisualizeData,
  x_scale: ScaleFunction | undefined,
  y_scale: ScaleFunction | undefined,
): string {
  if (!x_scale || !y_scale || data.chart_points.length === 0) {
    return '';
  }

  const path_segments: string[] = [];
  let previous_y = 0;

  data.chart_points.forEach((point, index) => {
    const x = x_scale(point.draw);
    const y = y_scale(clamp(point.cumulative, 0, 1));
    if (x === undefined || y === undefined) {
      return;
    }

    if (path_segments.length === 0) {
      path_segments.push(`M ${x.toFixed(2)} ${y.toFixed(2)}`);
    } else {
      path_segments.push(`L ${x.toFixed(2)} ${previous_y.toFixed(2)}`);
      path_segments.push(`L ${x.toFixed(2)} ${y.toFixed(2)}`);
    }

    previous_y = y;
  });

  return path_segments.join(' ');
}

function CDFOverlay({ data, animation_key }: CDFOverlayProps) {
  const plot_area = usePlotArea();
  const x_scale = useXAxisScale();
  const y_scale = useYAxisScale();
  const marker_views = useMemo(
    () => build_marker_views(data.markers, plot_area, x_scale, y_scale),
    [plot_area, x_scale, y_scale, data.markers],
  );
  const curve_path = useMemo(
    () => build_curve_path(data, x_scale, y_scale),
    [data, x_scale, y_scale],
  );
  const mean_marker = marker_views.find((view) => view.marker.key === 'MEAN');
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
                '--marker-index': index,
                '--marker-label-font-size': `${marker_visual.label_font_size}px`,
                '--marker-label-font-weight': marker_visual.label_font_weight,
                '--marker-label-stroke-width': `${marker_visual.label_stroke_width}px`,
                '--marker-opacity': marker_visual.opacity,
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

export function CDFChart({
  data,
  animation_key,
  is_animating,
}: CDFChartProps) {
  const [chart_ref, chart_size] = use_element_size<HTMLDivElement>();

  return (
    <div
      ref={chart_ref}
      className="cdf-chart-shell"
      data-testid="cdf-chart"
      data-animating={is_animating}
    >
      {/* Keep the Y-axis title outside Recharts so its rotated position stays stable in the responsive shell. */}
      <div className="y-axis-title">成功概率</div>
      {chart_size.width > 0 && chart_size.height > 0 && (
        <LineChart
          data={data.chart_points}
          height={chart_size.height}
          key={`cdf-line-${animation_key}`}
          margin={CHART_MARGIN}
          syncId="cdf-chart"
          width={chart_size.width}
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
            tick={{ fill: CDF_CHART_VIEW_CONFIG.x_tick_color, fontSize: 16 }}
            tickFormatter={format_draw}
            height={X_AXIS_HEIGHT}
            label={{
              value: '累计抽数',
              position: 'insideBottom',
              offset: -5,
              className: 'axis-title',
            }}
            tickLine={{ stroke: CDF_CHART_VIEW_CONFIG.axis_tick_color }}
            type="number"
          />
          <YAxis
            dataKey="cumulative"
            domain={[0, 1]}
            stroke={CDF_CHART_VIEW_CONFIG.axis_color}
            tick={{ fill: CDF_CHART_VIEW_CONFIG.y_tick_color, fontSize: 14 }}
            tickFormatter={format_percent}
            ticks={Y_CDF_AXIS_TICKS}
            tickMargin={10}
            tickLine={{ stroke: CDF_CHART_VIEW_CONFIG.axis_tick_color }}
            type="number"
            width={Y_AXIS_WIDTH}
          />
          <CDFOverlay data={data} animation_key={animation_key} />
        </LineChart>
      )}
    </div>
  );
}
