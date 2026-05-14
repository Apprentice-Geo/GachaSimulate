import { expect, test } from '@playwright/test';

const FIXTURE_PATH = 'src/visualize/fixtures/example_input.json';

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
  await expect(page.getByText('累计概率 CDF')).toBeVisible();
  await expect(page.getByText('较优结果')).toBeVisible();
  await expect(page.getByText('中心位置')).toBeVisible();
  await expect(page.getByText('尾部风险')).toBeVisible();
  await expect(page.getByTestId('stat-COST')).toBeVisible();

  const layout_ratio = await page.evaluate(() => {
    const chart = document.querySelector('.chart-region') as HTMLElement | null;
    const stats = document.querySelector('.statistic-panel') as HTMLElement | null;
    if (!chart || !stats) {
      return null;
    }
    return {
      chart_width: chart.getBoundingClientRect().width,
      stats_width: stats.getBoundingClientRect().width,
    };
  });
  expect(layout_ratio).not.toBeNull();
  expect(layout_ratio!.chart_width).toBeGreaterThan(
    layout_ratio!.stats_width * 2.6,
  );

  const marker_contract = await page.evaluate(() => {
    const mean = document.querySelector('[data-marker-key="MEAN"] .marker-line');
    const first_marker = document.querySelector('.marker-line');
    const pk = document.querySelector('.pk-bar[data-segment-count="2"]');
    if (!mean || !first_marker) {
      return null;
    }
    const marker_style = window.getComputedStyle(first_marker);
    const pk_style = pk ? window.getComputedStyle(pk) : null;
    return {
      mean_stroke: mean.getAttribute('stroke'),
      marker_dash: marker_style.strokeDasharray,
      pk_has_diagonal: pk_style?.getPropertyValue('--pk-seam-angle') ?? '',
    };
  });
  expect(marker_contract).not.toBeNull();
  expect(marker_contract!.mean_stroke).toBe('#952fc6');
  expect(marker_contract!.marker_dash).not.toBe('none');
  expect(marker_contract!.marker_dash).not.toBe('1px');
  expect(marker_contract!.pk_has_diagonal.trim()).toBe('-45deg');
  await expect(page.getByTestId('stat-P50')).toContainText('39');
  await expect(page.getByTestId('termination-bar')).toContainText('exchange');
  await expect(page.getByTestId('replay-animation')).toBeEnabled();
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
    { timeout: 5000 },
  );
  await expect(replay_button).toBeEnabled();
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
