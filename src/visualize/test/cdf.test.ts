import assert from 'node:assert/strict';
import { MARKER_COLORS, get_cdf_level_at_draw } from '../data/cdf';
import { MARKER_VISUALS } from '../components/cdf_marker_visuals';

const sparse_points = [
  { draw: 1, cumulative: 0.2 },
  { draw: 100, cumulative: 0.8 },
];

assert.equal(get_cdf_level_at_draw(sparse_points, 1), 0.2);
assert.equal(get_cdf_level_at_draw(sparse_points, 50), 0.2);
assert.equal(get_cdf_level_at_draw(sparse_points, 100), 0.8);
assert.equal(get_cdf_level_at_draw(sparse_points, 101), 0.8);
assert.equal(MARKER_COLORS.MEAN, '#952fc6');
assert.ok(MARKER_VISUALS.primary.opacity > MARKER_VISUALS.faint.opacity);
assert.ok(
  MARKER_VISUALS.primary.stroke_width > MARKER_VISUALS.faint.stroke_width,
);
assert.ok(
  MARKER_VISUALS.primary.point_radius > MARKER_VISUALS.faint.point_radius,
);
assert.ok(
  MARKER_VISUALS.primary.label_font_size >
    MARKER_VISUALS.faint.label_font_size,
);
