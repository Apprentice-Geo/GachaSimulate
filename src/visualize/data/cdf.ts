import type {
  CDFMarkerDatum,
  CDFPoint,
  VisualizeStatisticInput,
  VisualizeInput,
} from '../types/visualize_input';

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

export function build_marker_data_from_points(
  points: CDFPoint[],
  stat: VisualizeStatisticInput,
): CDFMarkerDatum[] {
  return [
    {
      key: 'MIN',
      draw: stat.MIN,
      level: get_cdf_level_at_draw(points, stat.MIN),
    },
    {
      key: 'P5',
      draw: stat.P5,
      level: get_cdf_level_at_draw(points, stat.P5),
    },
    {
      key: 'P25',
      draw: stat.P25,
      level: get_cdf_level_at_draw(points, stat.P25),
    },
    {
      key: 'P50',
      draw: stat.P50,
      level: get_cdf_level_at_draw(points, stat.P50),
    },
    {
      key: 'MEAN',
      draw: stat.MEAN,
      level: stat.MEAN_LEVEL,
    },
    {
      key: 'P75',
      draw: stat.P75,
      level: get_cdf_level_at_draw(points, stat.P75),
    },
    {
      key: 'P95',
      draw: stat.P95,
      level: get_cdf_level_at_draw(points, stat.P95),
    },
    {
      key: 'MAX',
      draw: stat.MAX,
      level: get_cdf_level_at_draw(points, stat.MAX),
    },
  ];
}

export function build_marker_data(input: VisualizeInput): CDFMarkerDatum[] {
  return build_marker_data_from_points(
    build_chart_points(input),
    input.statistic,
  );
}
