import type { CDFPoint } from "../types/cdf";

export function get_cdf_level_at_draw(
  points: CDFPoint[],
  draw: number,
): number {
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
