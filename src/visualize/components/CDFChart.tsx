import {
  CartesianGrid,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';
import { CDFOverlay } from './CDFOverlay';
import type { NormalizedVisualizeData } from '../types/visualize_input';
import { CDF_CHART_VIEW_CONFIG } from '../view/cdf_view_config';
import { use_element_size } from '../hooks/use_element_size';

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

function format_percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function format_draw(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 0,
  }).format(value);
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
