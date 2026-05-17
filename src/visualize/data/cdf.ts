import type {
  CDFMarker,
  CDFPoint,
  MarkerKey,
  VisualizeInput,
} from '../types/visualize_input';

export const MARKER_COLORS: Record<MarkerKey, string> = {
  MIN: '#3f8500',
  P5: '#3f8500',
  P25: '#76b900',
  P50: '#bff230',
  MEAN: '#952fc6',
  P75: '#ef9100',
  P95: '#df6500',
  MAX: '#e52020',
};

export function get_cdf_level_at_draw(points: CDFPoint[], draw: number): number {
  if (points.length === 0) {
    return 0;
  }

  const first_point = points[0];
  if (draw <= first_point.draw) {
    return first_point.cumulative;
  }

  for (let index = 1; index < points.length; index += 1) {
    const previous_point = points[index - 1];
    const next_point = points[index];

    if (draw === next_point.draw) {
      return next_point.cumulative;
    }

    if (draw < next_point.draw) {
      return previous_point.cumulative;
    }
  }

  return points[points.length - 1].cumulative;
}

export function build_chart_points(input: VisualizeInput): CDFPoint[] {
  return input.draws.map((draw, index) => ({
    draw,
    cumulative: input.cumulative[index],
  }));
}

export function build_markers(input: VisualizeInput): CDFMarker[] {
  const points = build_chart_points(input);
  const stat = input.statistic;

  return [
    {
      key: 'MIN',
      label: 'MIN',
      draw: stat.MIN,
      level: get_cdf_level_at_draw(points, stat.MIN),
      color: MARKER_COLORS.MIN,
      weight: 'faint',
    },
    {
      key: 'P5',
      label: 'P5',
      draw: stat.P5,
      level: get_cdf_level_at_draw(points, stat.P5),
      color: MARKER_COLORS.P5,
      weight: 'faint',
    },
    {
      key: 'P25',
      label: 'P25',
      draw: stat.P25,
      level: get_cdf_level_at_draw(points, stat.P25),
      color: MARKER_COLORS.P25,
      weight: 'normal',
    },
    {
      key: 'P50',
      label: 'P50',
      draw: stat.P50,
      level: get_cdf_level_at_draw(points, stat.P50),
      color: MARKER_COLORS.P50,
      weight: 'primary',
    },
    {
      key: 'MEAN',
      label: 'MEAN',
      draw: stat.MEAN,
      level: stat.MEAN_LEVEL,
      color: MARKER_COLORS.MEAN,
      weight: 'strong',
    },
    {
      key: 'P75',
      label: 'P75',
      draw: stat.P75,
      level: get_cdf_level_at_draw(points, stat.P75),
      color: MARKER_COLORS.P75,
      weight: 'normal',
    },
    {
      key: 'P95',
      label: 'P95',
      draw: stat.P95,
      level: get_cdf_level_at_draw(points, stat.P95),
      color: MARKER_COLORS.P95,
      weight: 'strong',
    },
    {
      key: 'MAX',
      label: 'MAX',
      draw: stat.MAX,
      level: get_cdf_level_at_draw(points, stat.MAX),
      color: MARKER_COLORS.MAX,
      weight: 'strong',
    },
  ];
}
