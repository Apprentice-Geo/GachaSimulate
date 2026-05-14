import type { CSSProperties } from 'react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';
import { get_marker_stroke_width } from '../data/cdf';
import type {
  CDFMarker,
  NormalizedVisualizeData,
} from '../types/visualize_input';

const CHART_MARGIN = {
  top: 58,
  right: 36,
  bottom: 72,
  left: 76,
};
const Y_AXIS_WIDTH = 60;
const X_AXIS_HEIGHT = 40;

interface CDFChartProps {
  data: NormalizedVisualizeData;
  animation_key: number;
  is_animating: boolean;
}

interface ElementSize {
  width: number;
  height: number;
}

interface MarkerView {
  marker: CDFMarker;
  x: number;
  y: number;
  label_x: number;
  label_y: number;
  text_anchor: 'start' | 'middle' | 'end';
  label_text: string;
}

interface PlotBox {
  left: number;
  top: number;
  width: number;
  height: number;
  bottom: number;
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

function build_marker_views(
  markers: CDFMarker[],
  plot_box: PlotBox | null,
  x_domain_max: number,
): MarkerView[] {
  if (!plot_box) {
    return [];
  }

  const p50 = markers.find((marker) => marker.key === 'P50');
  const mean = markers.find((marker) => marker.key === 'MEAN');
  const p50_x = p50
    ? plot_box.left + (p50.draw / x_domain_max) * plot_box.width
    : null;
  const mean_x = mean
    ? plot_box.left + (mean.draw / x_domain_max) * plot_box.width
    : null;
  const p50_mean_close =
    p50_x !== null && mean_x !== null && Math.abs(p50_x - mean_x) < 64;
  const mean_is_left = (mean?.draw ?? 0) <= (p50?.draw ?? 0);

  return markers.map((marker) => {
    const x = plot_box.left + (marker.draw / x_domain_max) * plot_box.width;
    const y =
      plot_box.top + (1 - clamp(marker.level, 0, 1)) * plot_box.height;
    let label_x = x;
    let text_anchor: MarkerView['text_anchor'] = 'middle';
    let label_text = marker.label;

    if (p50_mean_close && marker.key === 'MEAN') {
      label_x = x + (mean_is_left ? -10 : 10);
      text_anchor = mean_is_left ? 'end' : 'start';
      label_text = mean_is_left ? 'MEAN ' : ' MEAN';
    }

    if (p50_mean_close && marker.key === 'P50') {
      label_x = x + (mean_is_left ? 10 : -10);
      text_anchor = mean_is_left ? 'start' : 'end';
      label_text = mean_is_left ? ' P50' : 'P50 ';
    }

    return {
      marker,
      x,
      y,
      label_x,
      label_y: clamp(y - 12, plot_box.top + 18, plot_box.bottom - 12),
      text_anchor,
      label_text,
    };
  });
}

function get_plot_box(size: ElementSize): PlotBox | null {
  if (size.width <= 0 || size.height <= 0) {
    return null;
  }

  const width = size.width - CHART_MARGIN.left - CHART_MARGIN.right - Y_AXIS_WIDTH;
  const height =
    size.height - CHART_MARGIN.top - CHART_MARGIN.bottom - X_AXIS_HEIGHT;
  if (width <= 0 || height <= 0) {
    return null;
  }

  const top = CHART_MARGIN.top;
  return {
    left: CHART_MARGIN.left + Y_AXIS_WIDTH,
    top,
    width,
    height,
    bottom: top + height,
  };
}

function build_curve_path(
  data: NormalizedVisualizeData,
  plot_box: PlotBox | null,
): string {
  if (!plot_box || data.chart_points.length === 0) {
    return '';
  }

  const path_segments: string[] = [];
  let previous_y = 0;

  data.chart_points.forEach((point, index) => {
    const x = plot_box.left + (point.draw / data.x_domain_max) * plot_box.width;
    const y =
      plot_box.top + (1 - clamp(point.cumulative, 0, 1)) * plot_box.height;

    if (index === 0) {
      path_segments.push(`M ${x.toFixed(2)} ${y.toFixed(2)}`);
    } else {
      path_segments.push(`L ${x.toFixed(2)} ${previous_y.toFixed(2)}`);
      path_segments.push(`L ${x.toFixed(2)} ${y.toFixed(2)}`);
    }

    previous_y = y;
  });

  return path_segments.join(' ');
}

export function CDFChart({
  data,
  animation_key,
  is_animating,
}: CDFChartProps) {
  const [chart_ref, chart_size] = use_element_size<HTMLDivElement>();
  const plot_box = useMemo(() => get_plot_box(chart_size), [chart_size]);
  const marker_views = useMemo(
    () => build_marker_views(data.markers, plot_box, data.x_domain_max),
    [plot_box, data.markers, data.x_domain_max],
  );
  const curve_path = useMemo(
    () => build_curve_path(data, plot_box),
    [data, plot_box],
  );
  const mean_marker = marker_views.find((view) => view.marker.key === 'MEAN');

  return (
    <div
      ref={chart_ref}
      className="cdf-chart-shell"
      data-testid="cdf-chart"
      data-animating={is_animating}
    >
      <div className="chart-frame-label">
        <span>Cumulative Distribution Function</span>
        <span>draws → probability</span>
      </div>
      {chart_size.width > 0 && chart_size.height > 0 && (
        <LineChart
          data={data.chart_points}
          height={chart_size.height}
          key={`cdf-line-${animation_key}`}
          margin={CHART_MARGIN}
          syncId="cdf-chart"
          width={chart_size.width}
        >
          <CartesianGrid stroke="rgba(31, 22, 51, 0.08)" strokeDasharray="1 10" />
          <XAxis
            allowDecimals={false}
            dataKey="draw"
            domain={[0, data.x_domain_max]}
            stroke="#4c4658"
            tick={{ fill: '#4c4658', fontSize: 14 }}
            tickFormatter={format_draw}
            height={X_AXIS_HEIGHT}
            tickLine={{ stroke: '#c9cbd2' }}
            type="number"
          />
          <YAxis
            domain={[0, 1]}
            stroke="#4c4658"
            tick={{ fill: '#4c4658', fontSize: 14 }}
            tickFormatter={format_percent}
            tickLine={{ stroke: '#c9cbd2' }}
            width={Y_AXIS_WIDTH}
          />
        </LineChart>
      )}

      {chart_size.width > 0 && chart_size.height > 0 && plot_box && (
        <svg
          aria-hidden="true"
          className="marker-overlay"
          height={chart_size.height}
          key={`cdf-markers-${animation_key}`}
          width={chart_size.width}
        >
          <path
            className="cdf-curve-path"
            d={curve_path}
            data-testid="cdf-curve-path"
            fill="none"
            pathLength={1}
            stroke="#22d3ee"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={4}
          />
          {mean_marker && (
            <line
              className="mean-horizontal-line"
              pathLength={1}
              stroke={mean_marker.marker.color}
              strokeDasharray="1"
              strokeDashoffset="1"
              strokeWidth={get_marker_stroke_width(mean_marker.marker.weight)}
              x1={plot_box.left}
              x2={mean_marker.x}
              y1={mean_marker.y}
              y2={mean_marker.y}
            />
          )}

          {marker_views.map((view, index) => (
            <g
              className={`marker-group marker-${view.marker.weight}`}
              key={view.marker.key}
              style={
                {
                  '--marker-color': view.marker.color,
                  '--marker-index': index,
                } as CSSProperties
              }
            >
              <line
                className="marker-line"
                pathLength={1}
                stroke={view.marker.color}
                strokeDasharray="1"
                strokeDashoffset="1"
                strokeWidth={get_marker_stroke_width(view.marker.weight)}
                x1={view.x}
                x2={view.x}
                y1={plot_box.bottom}
                y2={view.y}
              />
              <circle
                className="marker-point"
                cx={view.x}
                cy={view.y}
                fill={view.marker.color}
                r={view.marker.weight === 'primary' ? 5 : 3.8}
              />
              <text
                className="marker-label"
                fill={view.marker.color}
                textAnchor={view.text_anchor}
                x={view.label_x}
                y={view.label_y}
              >
                {view.label_text}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
