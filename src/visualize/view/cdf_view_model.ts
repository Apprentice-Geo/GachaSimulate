import { build_marker_data } from '../data/cdf';
import type { CDFMarker, StatisticKey, VisualizeInput } from '../types/visualize_input';
import { CDF_MARKER_VIEW_CONFIG } from './cdf_view_config';

export function build_markers(input: VisualizeInput): CDFMarker[] {
  return build_marker_data(input).map((marker) => {
    const config = CDF_MARKER_VIEW_CONFIG[marker.key];

    return {
      ...marker,
      label: config.label,
      color: config.color,
      weight: config.weight,
    };
  });
}

export function get_metric_color(key: StatisticKey): string {
  if (key === 'COST') {
    return 'var(--color-sentry-primary)';
  }

  return CDF_MARKER_VIEW_CONFIG[key].color;
}
