import assert from 'node:assert/strict';
import { MARKER_COLORS, get_cdf_level_at_draw } from '../data/cdf';

const sparse_points = [
  { draw: 1, cumulative: 0.2 },
  { draw: 100, cumulative: 0.8 },
];

assert.equal(get_cdf_level_at_draw(sparse_points, 1), 0.2);
assert.equal(get_cdf_level_at_draw(sparse_points, 50), 0.2);
assert.equal(get_cdf_level_at_draw(sparse_points, 100), 0.8);
assert.equal(get_cdf_level_at_draw(sparse_points, 101), 0.8);
assert.equal(MARKER_COLORS.MEAN, '#952fc6');
