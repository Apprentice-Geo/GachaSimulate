import { expect, test } from '@playwright/test';

const FIXTURE_PATH = 'src/visualize/fixtures/example_input.json';
const ANIMATION_IDLE_TIMEOUT_MS = 7000;

test('shows empty state before data import', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('visualize-root')).toHaveAttribute(
    'data-load-state',
    'idle',
  );
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByTestId('cdf-chart')).toHaveCount(0);
});

test('loads fixture from url input and exposes export selectors', async ({ page }) => {
  await page.route('**/__visualize_input?**', async (route) => {
    const response = await route.fetch();
    const input = await response.json();
    await route.fulfill({
      json: {
        ...input,
        statistic: {
          ...input.statistic,
          COST: 6,
        },
        note: '测试用底部说明',
      },
    });
  });

  await page.goto(`/?input=${encodeURIComponent(FIXTURE_PATH)}`, {
    waitUntil: 'networkidle',
  });

  await expect(page.getByTestId('visualize-root')).toHaveAttribute(
    'data-load-state',
    'ready',
  );
  await expect(page.getByRole('heading', { name: '抽卡模拟 CDF 分析' })).toBeVisible();
  await expect(page.getByTestId('cdf-chart')).toBeVisible();
  await expect(page.locator('.recharts-surface')).toBeVisible();
  await expect(page.getByTestId('cdf-curve-path')).toHaveAttribute('d', /M/);
  await expect(page.getByText('成功概率')).toBeVisible();
  await expect(page.getByText('累计抽数')).toBeVisible();
  const y_axis_ticks = await page
    .locator('.recharts-cartesian-axis-tick-value')
    .evaluateAll((ticks) =>
      ticks
        .map((tick) => tick.textContent?.trim() ?? '')
        .filter((text) => /^\d+%$/.test(text)),
    );
  expect(y_axis_ticks).toEqual(['0%', '5%', '25%', '50%', '75%', '95%', '100%']);
  await expect(page.getByRole('heading', { name: '低抽数区间' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '中抽数区间' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '高抽数区间' })).toBeVisible();
  await expect(page.getByText('单抽成本: 6 RMB')).toBeVisible();
  await expect(page.getByTestId('stat-COST')).toHaveCount(0);
  await expect(page.getByTestId('visualize-root')).toHaveAttribute(
    'data-animation-state',
    'idle',
    { timeout: ANIMATION_IDLE_TIMEOUT_MS },
  );

  const layout_contract = await page.evaluate(() => {
    const chart = document.querySelector('.chart-region') as HTMLElement | null;
    const stats = document.querySelector('.statistic-panel') as HTMLElement | null;
    const pk = document.querySelector('.pk-bar') as HTMLElement | null;
    const termination = document.querySelector(
      '.termination-region',
    ) as HTMLElement | null;
    const page = document.querySelector('.visualize-page') as HTMLElement | null;
    const main = document.querySelector('.main-region') as HTMLElement | null;
    const note = document.querySelector('.page-note') as HTMLElement | null;
    if (!chart || !stats || !pk || !termination || !page || !main || !note) {
      return null;
    }
    const page_rect = page.getBoundingClientRect();
    const main_rect = main.getBoundingClientRect();
    const chart_rect = chart.getBoundingClientRect();
    const stats_rect = stats.getBoundingClientRect();
    const termination_rect = termination.getBoundingClientRect();
    const pk_rect = pk.getBoundingClientRect();
    const note_rect = note.getBoundingClientRect();
    return {
      chart_width: chart_rect.width,
      stats_width: stats_rect.width,
      chart_left: chart_rect.left,
      chart_right: chart_rect.right,
      main_bottom: main_rect.bottom,
      note_center_x: note_rect.left + note_rect.width / 2,
      note_top: note_rect.top,
      page_center_x: page_rect.left + page_rect.width / 2,
      page_bottom: page_rect.bottom,
      pk_width: pk_rect.width,
      termination_left: termination_rect.left,
      termination_right: termination_rect.right,
      termination_width: termination_rect.width,
      stats_top: stats_rect.top,
      stats_bottom: stats_rect.bottom,
      chart_top: chart_rect.top,
      termination_bottom: termination_rect.bottom,
    };
  });
  expect(layout_contract).not.toBeNull();
  expect(layout_contract!.chart_width).toBeGreaterThan(
    layout_contract!.stats_width * 2.6,
  );
  expect(layout_contract!.termination_left).toBeCloseTo(
    layout_contract!.chart_left,
    1,
  );
  expect(layout_contract!.termination_right).toBeCloseTo(
    layout_contract!.chart_right,
    1,
  );
  expect(layout_contract!.stats_top).toBeCloseTo(layout_contract!.chart_top, 1);
  expect(layout_contract!.stats_bottom).toBeCloseTo(
    layout_contract!.termination_bottom,
    1,
  );
  expect(layout_contract!.note_top).toBeGreaterThan(
    layout_contract!.main_bottom,
  );
  expect(layout_contract!.page_bottom).toBeGreaterThan(
    layout_contract!.note_top,
  );
  expect(layout_contract!.page_bottom - layout_contract!.main_bottom).toBeGreaterThan(
    32,
  );
  expect(layout_contract!.note_center_x).toBeCloseTo(
    layout_contract!.page_center_x,
    1,
  );
  expect(layout_contract!.pk_width).toBeGreaterThan(
    layout_contract!.termination_width * 0.85,
  );

  const marker_contract = await page.evaluate(() => {
    const mean = document.querySelector('[data-marker-key="MEAN"] .marker-line');
    const first_marker = document.querySelector('.marker-line');
    const pk = document.querySelector('.pk-bar[data-segment-count="2"]');
    if (!mean || !first_marker) {
      return null;
    }
    const marker_style = window.getComputedStyle(first_marker);
    const mean_style = window.getComputedStyle(mean);
    const pk_style = pk ? window.getComputedStyle(pk) : null;
    return {
      mean_stroke: mean_style.stroke,
      marker_dash: marker_style.strokeDasharray,
      pk_has_diagonal: pk_style?.getPropertyValue('--pk-seam-angle') ?? '',
    };
  });
  expect(marker_contract).not.toBeNull();
  expect(marker_contract!.mean_stroke).toBe('rgb(149, 47, 198)');
  expect(marker_contract!.marker_dash).not.toBe('none');
  expect(marker_contract!.marker_dash).not.toBe('1px');
  expect(marker_contract!.pk_has_diagonal.trim()).toBe('-45deg');
  const pk_fill_contract = await page.evaluate(() => {
    const pk = document.querySelector('.pk-bar[data-segment-count="2"]');
    const segments = [...document.querySelectorAll('.pk-segment')];
    if (!pk || segments.length !== 2) {
      return null;
    }
    const pk_style = window.getComputedStyle(pk);
    const pk_rect = pk.getBoundingClientRect();
    const last_segment_rect = segments[1].getBoundingClientRect();
    return {
      pk_inner_right:
        pk_rect.right - Number.parseFloat(pk_style.borderRightWidth),
      last_segment_right: last_segment_rect.right,
    };
  });
  expect(pk_fill_contract).not.toBeNull();
  expect(pk_fill_contract!.last_segment_right).toBeCloseTo(
    pk_fill_contract!.pk_inner_right,
    1,
  );
  await expect(page.getByTestId('stat-P50')).toContainText('39');
  await expect(page.getByTestId('termination-bar')).toBeVisible();
  await expect(page.getByRole('heading', { name: '达成情况分布' })).toBeVisible();
  await expect(page.getByTestId('termination-bar')).toContainText('exchange');
  await expect(page.getByTestId('termination-bar')).toContainText('96%');
  await expect(page.getByText('测试用底部说明')).toBeVisible();
  await expect(page.getByTestId('replay-animation')).toBeEnabled();
});

test('renders cdf overlay inside recharts svg so markers share axis scales', async ({ page }) => {
  await page.goto(`/?input=${encodeURIComponent(FIXTURE_PATH)}`, {
    waitUntil: 'networkidle',
  });
  await expect(page.getByTestId('cdf-chart')).toBeVisible();

  const overlay_contract = await page.evaluate(() => {
    const surface_overlay = document.querySelector('.recharts-surface .marker-overlay');
    const detached_overlay = document.querySelector('svg.marker-overlay');
    const p50_line = document.querySelector(
      '.recharts-surface [data-marker-key="P50"] .marker-line',
    );
    const p50_point = document.querySelector(
      '.recharts-surface [data-marker-key="P50"] .marker-point',
    );

    if (!surface_overlay || !p50_line || !p50_point) {
      return null;
    }

    return {
      has_detached_overlay: detached_overlay !== null,
      line_x: Number(p50_line.getAttribute('x1')),
      point_x: Number(p50_point.getAttribute('cx')),
      line_y: Number(p50_line.getAttribute('y2')),
      point_y: Number(p50_point.getAttribute('cy')),
    };
  });

  expect(overlay_contract).not.toBeNull();
  expect(overlay_contract!.has_detached_overlay).toBe(false);
  expect(overlay_contract!.line_x).toBeCloseTo(overlay_contract!.point_x, 2);
  expect(overlay_contract!.line_y).toBeCloseTo(overlay_contract!.point_y, 2);
});

test('orders p50 and mean statistic cards by draw count', async ({ page }) => {
  await page.goto(`/?input=${encodeURIComponent(FIXTURE_PATH)}`, {
    waitUntil: 'networkidle',
  });
  await expect(page.getByTestId('stat-P50')).toBeVisible();
  await expect(page.getByTestId('stat-MEAN')).toBeVisible();

  const default_order = await page.evaluate(() => {
    const p50 = document.querySelector('[data-testid="stat-P50"]');
    const mean = document.querySelector('[data-testid="stat-MEAN"]');
    return {
      mean_top: mean?.getBoundingClientRect().top ?? 0,
      p50_top: p50?.getBoundingClientRect().top ?? 0,
    };
  });
  expect(default_order.mean_top).toBeLessThan(default_order.p50_top);

  await page.route('**/__visualize_input?**', async (route) => {
    const response = await route.fetch();
    const input = await response.json();
    await route.fulfill({
      json: {
        ...input,
        statistic: {
          ...input.statistic,
          MEAN: input.statistic.P50,
        },
      },
    });
  });

  await page.goto(`/?input=${encodeURIComponent(FIXTURE_PATH)}&tie=1`, {
    waitUntil: 'networkidle',
  });
  await expect(page.getByTestId('stat-P50')).toBeVisible();
  await expect(page.getByTestId('stat-MEAN')).toBeVisible();

  const tie_order = await page.evaluate(() => {
    const p50 = document.querySelector('[data-testid="stat-P50"]');
    const mean = document.querySelector('[data-testid="stat-MEAN"]');
    return {
      p50_top: p50?.getBoundingClientRect().top ?? 0,
      mean_top: mean?.getBoundingClientRect().top ?? 0,
    };
  });
  expect(tie_order.p50_top).toBeLessThan(tie_order.mean_top);
});

test('draws quantile markers at their quantile y-axis levels', async ({ page }) => {
  await page.goto(`/?input=${encodeURIComponent(FIXTURE_PATH)}`, {
    waitUntil: 'networkidle',
  });
  await expect(page.getByTestId('cdf-chart')).toBeVisible();

  const quantile_alignment = await page.evaluate(() => {
    const get_tick_y = (label: string) => {
      const tick = [
        ...document.querySelectorAll('.recharts-cartesian-axis-tick-value'),
      ]
        .find((element) => element.textContent?.trim() === label);
      return tick ? Number(tick.getAttribute('y')) : null;
    };
    const get_marker_y = (key: string) => {
      const point = document.querySelector(
        `[data-marker-key="${key}"] .marker-point`,
      );
      return point ? Number(point.getAttribute('cy')) : null;
    };

    return {
      p5: { marker_y: get_marker_y('P5'), tick_y: get_tick_y('5%') },
      p25: { marker_y: get_marker_y('P25'), tick_y: get_tick_y('25%') },
      p50: { marker_y: get_marker_y('P50'), tick_y: get_tick_y('50%') },
      p75: { marker_y: get_marker_y('P75'), tick_y: get_tick_y('75%') },
      p95: { marker_y: get_marker_y('P95'), tick_y: get_tick_y('95%') },
    };
  });

  for (const alignment of Object.values(quantile_alignment)) {
    expect(alignment.marker_y).not.toBeNull();
    expect(alignment.tick_y).not.toBeNull();
    expect(alignment.marker_y!).toBeCloseTo(alignment.tick_y!, 2);
  }
});

test('renders cdf marker labels with readable non-overlapping placement', async ({
  page,
}) => {
  await page.goto(`/?input=${encodeURIComponent(FIXTURE_PATH)}`, {
    waitUntil: 'networkidle',
  });
  await expect(page.getByTestId('cdf-chart')).toBeVisible();

  const marker_layout = await page.evaluate(() => {
    const read_marker = (key: string) => {
      const group = document.querySelector(`[data-marker-key="${key}"]`);
      const point = group?.querySelector('.marker-point');
      const label = group?.querySelector('.marker-label');
      if (!group || !point || !label) {
        return null;
      }

      const label_style = window.getComputedStyle(label);
      return {
        point_x: Number(point.getAttribute('cx')),
        point_y: Number(point.getAttribute('cy')),
        radius: Number(point.getAttribute('r')),
        label_x: Number(label.getAttribute('x')),
        label_y: Number(label.getAttribute('y')),
        anchor: label.getAttribute('text-anchor'),
        baseline: label.getAttribute('dominant-baseline'),
        font_size: Number.parseFloat(label_style.fontSize),
      };
    };

    return {
      p50: read_marker('P50'),
      mean: read_marker('MEAN'),
      max: read_marker('MAX'),
    };
  });

  expect(marker_layout.p50).not.toBeNull();
  expect(marker_layout.mean).not.toBeNull();
  expect(marker_layout.max).not.toBeNull();

  expect(marker_layout.mean!.label_x).toBeLessThan(marker_layout.mean!.point_x);
  expect(marker_layout.p50!.label_x).toBeLessThan(marker_layout.p50!.point_x);
  expect(marker_layout.mean!.anchor).toBe('end');
  expect(marker_layout.p50!.anchor).toBe('end');
  expect(marker_layout.mean!.baseline).toBe('hanging');
  expect(marker_layout.p50!.baseline).toBe('text-after-edge');
  expect(marker_layout.max!.label_y).toBeLessThan(marker_layout.max!.point_y);
  expect(marker_layout.p50!.radius).toBeGreaterThanOrEqual(6);
  expect(marker_layout.mean!.radius).toBeGreaterThanOrEqual(5.5);
  expect(marker_layout.max!.radius).toBeGreaterThanOrEqual(5.5);
  expect(marker_layout.p50!.font_size).toBeGreaterThanOrEqual(16);
  expect(marker_layout.mean!.font_size).toBeGreaterThanOrEqual(16);
  expect(marker_layout.max!.font_size).toBeGreaterThanOrEqual(16);
});

test('keeps p50 and mean labels on the left with vertical order from statistic values', async ({
  page,
}) => {
  await page.route('**/__visualize_input?**', async (route) => {
    const response = await route.fetch();
    const input = await response.json();
    await route.fulfill({
      json: {
        ...input,
        statistic: {
          ...input.statistic,
          MEAN: 60,
          MEAN_LEVEL: 0.9997596278978618,
        },
      },
    });
  });

  await page.goto(`/?input=${encodeURIComponent(FIXTURE_PATH)}`, {
    waitUntil: 'networkidle',
  });
  await expect(page.getByTestId('cdf-chart')).toBeVisible();

  const marker_layout = await page.evaluate(() => {
    const read_marker = (key: string) => {
      const group = document.querySelector(`[data-marker-key="${key}"]`);
      const point = group?.querySelector('.marker-point');
      const label = group?.querySelector('.marker-label');
      if (!group || !point || !label) {
        return null;
      }

      return {
        point_x: Number(point.getAttribute('cx')),
        label_x: Number(label.getAttribute('x')),
        anchor: label.getAttribute('text-anchor'),
        baseline: label.getAttribute('dominant-baseline'),
      };
    };

    return {
      p50: read_marker('P50'),
      mean: read_marker('MEAN'),
    };
  });

  expect(marker_layout.p50).not.toBeNull();
  expect(marker_layout.mean).not.toBeNull();

  expect(marker_layout.p50!.label_x).toBeLessThan(marker_layout.p50!.point_x);
  expect(marker_layout.mean!.label_x).toBeLessThan(marker_layout.mean!.point_x);
  expect(marker_layout.p50!.anchor).toBe('end');
  expect(marker_layout.mean!.anchor).toBe('end');
  expect(marker_layout.p50!.baseline).toBe('hanging');
  expect(marker_layout.mean!.baseline).toBe('text-after-edge');
});

test('shows clear error state for failed url input', async ({ page }) => {
  await page.goto('/?input=src/visualize/fixtures/missing.json', {
    waitUntil: 'networkidle',
  });

  await expect(page.getByTestId('visualize-root')).toHaveAttribute(
    'data-load-state',
    'error',
  );
  await expect(page.getByTestId('error-state')).toBeVisible();
  await expect(page.getByTestId('error-state')).toContainText('无法读取 input 文件');
});

test('replay button disables while animation is running', async ({ page }) => {
  await page.goto(`/?input=${encodeURIComponent(FIXTURE_PATH)}`, {
    waitUntil: 'networkidle',
  });
  await expect(page.getByTestId('visualize-root')).toHaveAttribute(
    'data-load-state',
    'ready',
  );

  const replay_button = page.getByTestId('replay-animation');
  await expect(replay_button).toBeEnabled({ timeout: 5000 });
  await replay_button.click();
  await expect(replay_button).toBeDisabled();
  const animation_order = await page.evaluate(() => {
    const to_ms = (value: string) => {
      const first_value = value.split(',')[0]?.trim() ?? '0s';
      return first_value.endsWith('ms')
        ? Number.parseFloat(first_value)
        : Number.parseFloat(first_value) * 1000;
    };
    const curve = document.querySelector('[data-testid="cdf-curve-path"]');
    const marker = document.querySelector('.marker-line');
    const metric = document.querySelector('.metric-row');
    if (!curve || !marker || !metric) {
      return null;
    }

    const curve_style = window.getComputedStyle(curve);
    const marker_style = window.getComputedStyle(marker);
    const metric_style = window.getComputedStyle(metric);
    return {
      curve_ends_at:
        to_ms(curve_style.animationDelay) +
        to_ms(curve_style.animationDuration),
      marker_delay: to_ms(marker_style.animationDelay),
      metric_delay: to_ms(metric_style.animationDelay),
    };
  });
  expect(animation_order).not.toBeNull();
  expect(animation_order!.marker_delay).toBeGreaterThanOrEqual(
    animation_order!.curve_ends_at,
  );
  expect(animation_order!.metric_delay).toBeGreaterThanOrEqual(
    animation_order!.curve_ends_at,
  );
  await expect(page.getByTestId('visualize-root')).toHaveAttribute(
    'data-animation-state',
    'idle',
    { timeout: ANIMATION_IDLE_TIMEOUT_MS },
  );
  await expect(replay_button).toBeEnabled();
});

test('reveals page note after other animated components', async ({ page }) => {
  await page.goto(`/?input=${encodeURIComponent(FIXTURE_PATH)}&autoplay=0`, {
    waitUntil: 'networkidle',
  });
  await expect(page.getByTestId('visualize-root')).toHaveAttribute(
    'data-load-state',
    'ready',
  );

  await page.getByTestId('replay-animation').click();
  const animation_order = await page.evaluate(() => {
    const to_ms = (value: string) => {
      const first_value = value.split(',')[0]?.trim() ?? '0s';
      return first_value.endsWith('ms')
        ? Number.parseFloat(first_value)
        : Number.parseFloat(first_value) * 1000;
    };
    const note = document.querySelector('.page-note');
    if (!note) {
      return null;
    }

    const animated_elements = [
      '.top-bar',
      '.cdf-chart-shell',
      '.cdf-chart-shell .recharts-wrapper',
      '[data-testid="cdf-curve-path"]',
      '.marker-line',
      '.mean-horizontal-line',
      '.marker-group',
      '.termination-region',
      '.pk-bar',
      '.pk-segment',
      '.reason-list',
      '.statistic-panel',
      '.metric-group-heading',
      '.metric-row',
    ].flatMap((selector) => [...document.querySelectorAll(selector)]);
    const latest_component_end = Math.max(
      ...animated_elements.map((element) => {
        const style = window.getComputedStyle(element);
        return to_ms(style.animationDelay) + to_ms(style.animationDuration);
      }),
    );
    const note_style = window.getComputedStyle(note);
    return {
      latest_component_end,
      note_delay: to_ms(note_style.animationDelay),
      note_duration: to_ms(note_style.animationDuration),
    };
  });

  expect(animation_order).not.toBeNull();
  expect(animation_order!.note_delay).toBeGreaterThanOrEqual(
    animation_order!.latest_component_end,
  );
  expect(animation_order!.note_duration).toBe(200);
});

test('autoplay off keeps export page primed before replay', async ({ page }) => {
  await page.goto(`/?input=${encodeURIComponent(FIXTURE_PATH)}&autoplay=0`, {
    waitUntil: 'networkidle',
  });
  await expect(page.getByTestId('visualize-root')).toHaveAttribute(
    'data-load-state',
    'ready',
  );
  await expect(page.getByTestId('visualize-root')).toHaveAttribute(
    'data-animation-state',
    'primed',
  );

  const curve_dashoffset = await page
    .getByTestId('cdf-curve-path')
    .evaluate((element) => window.getComputedStyle(element).strokeDashoffset);
  expect(curve_dashoffset).toBe('1px');
});
