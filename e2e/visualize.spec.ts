import { expect, test, type Page } from "@playwright/test";

const FIXTURE_PATH = "src/visualize/fixtures/example_input.json";
const ANIMATION_IDLE_TIMEOUT_MS = 7000;

type FixtureOptions = {
  autoplay?: boolean;
  fastAnimations?: boolean;
  params?: Record<string, string>;
};

function build_fixture_url(options: FixtureOptions = {}) {
  const params = new URLSearchParams({
    input: FIXTURE_PATH,
    ...options.params,
  });
  if (options.autoplay === false) {
    params.set("autoplay", "0");
  }
  return `/?${params.toString()}`;
}

async function goto_fixture(page: Page, options: FixtureOptions = {}) {
  await page.goto(build_fixture_url(options), {
    waitUntil: "domcontentloaded",
  });
  if (options.fastAnimations !== false) {
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-delay: 0ms !important;
          animation-duration: 1ms !important;
          transition-delay: 0ms !important;
          transition-duration: 1ms !important;
        }
      `,
    });
  }
  await expect(page.getByTestId("visualize-root")).toHaveAttribute(
    "data-load-state",
    "ready",
  );
}

test("shows empty state before data import", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("visualize-root")).toHaveAttribute(
    "data-load-state",
    "idle",
  );
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("cdf-chart")).toHaveCount(0);
});

test("loads fixture from url input and renders dynamic page regions", async ({
  page,
}) => {
  await goto_fixture(page);

  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator(".title-stack p")).toBeVisible();
  await expect(page.getByTestId("cdf-chart")).toBeVisible();
  await expect(page.getByTestId("cdf-curve-path")).toHaveAttribute("d", /M/);
  await expect(page.getByText("累计占比")).toBeVisible();
  await expect(page.getByText("结束时的抽数")).toBeVisible();
  await expect(page.getByRole("heading", { name: "偏低结果" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "典型结果" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "偏高结果" })).toBeVisible();
  await expect(page.getByText("单抽 10 RMB；十连抽 90 RMB")).toBeVisible();
  await expect(page.getByTestId("statistic-panel")).toBeVisible();
  await expect(page.getByTestId("stat-COST")).toHaveCount(0);
  await expect(page.getByTestId("termination-bar")).toBeVisible();
  await expect(page.locator(".pk-segment")).toHaveCount(3);
  await expect(page.locator('[data-segment-position="start"]')).toHaveCount(1);
  await expect(page.locator('[data-segment-position="middle"]')).toHaveCount(1);
  await expect(page.locator('[data-segment-position="end"]')).toHaveCount(1);
  const seam_clip_paths = await page
    .locator('[data-segment-position="middle"], [data-segment-position="end"]')
    .evaluateAll((segments) =>
      segments.map((segment) => getComputedStyle(segment).clipPath),
    );
  expect(seam_clip_paths).toEqual([
    "polygon(68px 0px, 100% 0px, 100% 100%, 0px 100%)",
    "polygon(68px 0px, 100% 0px, 100% 100%, 0px 100%)",
  ]);
  await expect(
    page.getByTestId("stat-P50").locator(".metric-value"),
  ).toHaveText("39");
  await expect(page.locator(".termination-heading h2")).toBeVisible();
  await expect(page.locator(".page-note")).toBeVisible();
});

test("renders generic result item wording, units, and opaque price text", async ({
  page,
}) => {
  await page.route("**/__visualize_input?**", async (route) => {
    const response = await route.fetch();
    const input = await response.json();
    await route.fulfill({
      json: {
        ...input,
        result_item: { id: "tokens", name: "代币" },
        total: 1234,
        price: "单抽 10 RMB；十连抽 90 RMB",
        unit: "测试币",
        termination_reason: [{ reason: "达成", proportion: 100 }],
      },
    });
  });

  await goto_fixture(page);

  await expect(page.getByText("结束时的代币", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "偏低结果" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "典型结果" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "偏高结果" })).toBeVisible();
  await expect(page.getByText("累计模拟次数：1,000,000 次")).toBeVisible();
  await expect(
    page.getByText("单抽 10 RMB；十连抽 90 RMB", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".top-meta")).not.toContainText(
    "十连抽 90 RMB 测试币",
  );
  await expect(
    page.getByTestId("stat-P50").locator(".metric-value"),
  ).toHaveText("39");
});

test("keeps export layout regions present and readable", async ({ page }) => {
  await goto_fixture(page);

  const layout_contract = await page.evaluate(() => {
    const regions = [
      ".chart-region",
      ".statistic-panel",
      ".termination-region",
      ".main-region",
      ".page-note",
    ].map((selector) => document.querySelector(selector));
    if (regions.some((element) => element === null)) {
      return null;
    }

    const [chart, stats, termination, main, note] = regions as HTMLElement[];
    const chart_rect = chart.getBoundingClientRect();
    const stats_rect = stats.getBoundingClientRect();
    const termination_rect = termination.getBoundingClientRect();
    const main_rect = main.getBoundingClientRect();
    const note_rect = note.getBoundingClientRect();

    return {
      chart_width: chart_rect.width,
      chart_height: chart_rect.height,
      stats_width: stats_rect.width,
      stats_height: stats_rect.height,
      termination_width: termination_rect.width,
      termination_height: termination_rect.height,
      note_below_main: note_rect.top >= main_rect.bottom,
    };
  });

  expect(layout_contract).not.toBeNull();
  expect(layout_contract!.chart_width).toBeGreaterThan(0);
  expect(layout_contract!.chart_height).toBeGreaterThan(0);
  expect(layout_contract!.stats_width).toBeGreaterThan(0);
  expect(layout_contract!.stats_height).toBeGreaterThan(0);
  expect(layout_contract!.termination_width).toBeGreaterThan(0);
  expect(layout_contract!.termination_height).toBeGreaterThan(0);
  expect(layout_contract!.note_below_main).toBe(true);
});

test("refits the preview after viewport resize without changing its aspect ratio", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("visualize-root")).toHaveAttribute(
    "data-load-state",
    "idle",
  );

  await page.setViewportSize({ width: 1536, height: 900 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--page-scale",
          ),
        ),
      ),
    )
    .toBeCloseTo(1536 / 3840, 5);

  const fit_contract = await page.evaluate(() => {
    const viewport = document.querySelector(".visualize-viewport");
    const visualize_root = document.querySelector(
      '[data-testid="visualize-root"]',
    );
    if (
      !(viewport instanceof HTMLElement) ||
      !(visualize_root instanceof HTMLElement)
    ) {
      return null;
    }

    const viewport_rect = viewport.getBoundingClientRect();
    const visualize_rect = visualize_root.getBoundingClientRect();

    return {
      aspect_ratio: visualize_rect.width / visualize_rect.height,
      bottom_space: viewport_rect.bottom - visualize_rect.bottom,
      client_width: viewport.clientWidth,
      scroll_width: viewport.scrollWidth,
      client_height: viewport.clientHeight,
      scroll_height: viewport.scrollHeight,
      left_space: visualize_rect.left - viewport_rect.left,
      right_space: viewport_rect.right - visualize_rect.right,
      top_space: visualize_rect.top - viewport_rect.top,
    };
  });

  expect(fit_contract).not.toBeNull();
  expect(fit_contract!.scroll_width).toBe(fit_contract!.client_width);
  expect(fit_contract!.scroll_height).toBe(fit_contract!.client_height);
  expect(fit_contract!.aspect_ratio).toBeCloseTo(16 / 9, 5);
  expect(fit_contract!.left_space).toBeCloseTo(fit_contract!.right_space, 5);
  expect(fit_contract!.top_space).toBeCloseTo(fit_contract!.bottom_space, 5);
  expect(fit_contract!.top_space).toBeGreaterThan(0);
});

test("renders statistic and termination summaries", async ({ page }) => {
  await goto_fixture(page);

  await expect(page.getByTestId("stat-P50")).toBeVisible();
  await expect(page.getByTestId("termination-bar")).toBeVisible();
  await expect(page.locator(".termination-heading h2")).toBeVisible();
  await expect(page.locator(".reason-item").first()).toBeVisible();
  await expect(page.locator(".page-note")).toBeVisible();
});

test("renders cdf overlay so markers share curve coordinates", async ({
  page,
}) => {
  await goto_fixture(page);

  const overlay_contract = await page.evaluate(() => {
    const p50_line = document.querySelector(
      '[data-marker-key="P50"] .marker-line',
    );
    const p50_point = document.querySelector(
      '[data-marker-key="P50"] .marker-point',
    );

    if (!p50_line || !p50_point) {
      return null;
    }

    return {
      line_x: Number(p50_line.getAttribute("x1")),
      point_x: Number(p50_point.getAttribute("cx")),
      line_y: Number(p50_line.getAttribute("y2")),
      point_y: Number(p50_point.getAttribute("cy")),
    };
  });

  expect(overlay_contract).not.toBeNull();
  expect(overlay_contract!.line_x).toBeCloseTo(overlay_contract!.point_x, 2);
  expect(overlay_contract!.line_y).toBeCloseTo(overlay_contract!.point_y, 2);
});

test("orders p50 and mean statistic cards by draw count", async ({ page }) => {
  await goto_fixture(page);
  await expect(page.getByTestId("stat-P50")).toBeVisible();
  await expect(page.getByTestId("stat-MEAN")).toBeVisible();

  const default_order = await page.evaluate(() => {
    const p50 = document.querySelector('[data-testid="stat-P50"]');
    const mean = document.querySelector('[data-testid="stat-MEAN"]');
    return {
      mean_top: mean?.getBoundingClientRect().top ?? 0,
      p50_top: p50?.getBoundingClientRect().top ?? 0,
    };
  });
  expect(default_order.mean_top).toBeLessThan(default_order.p50_top);

  await page.route("**/__visualize_input?**", async (route) => {
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

  await goto_fixture(page, { params: { tie: "1" } });
  await expect(page.getByTestId("stat-P50")).toBeVisible();
  await expect(page.getByTestId("stat-MEAN")).toBeVisible();

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

test("draws quantile markers at their configured y levels", async ({
  page,
}) => {
  await goto_fixture(page);

  const quantile_alignment = await page.evaluate(() => {
    const get_marker_y = (key: string) => {
      const point = document.querySelector(
        `[data-marker-key="${key}"] .marker-point`,
      );
      return point ? Number(point.getAttribute("cy")) : null;
    };

    return {
      p5: get_marker_y("P5"),
      p25: get_marker_y("P25"),
      p50: get_marker_y("P50"),
      p75: get_marker_y("P75"),
      p95: get_marker_y("P95"),
    };
  });

  expect(quantile_alignment.p5).not.toBeNull();
  expect(quantile_alignment.p25).not.toBeNull();
  expect(quantile_alignment.p50).not.toBeNull();
  expect(quantile_alignment.p75).not.toBeNull();
  expect(quantile_alignment.p95).not.toBeNull();
  expect(quantile_alignment.p5!).toBeGreaterThan(quantile_alignment.p25!);
  expect(quantile_alignment.p25!).toBeGreaterThan(quantile_alignment.p50!);
  expect(quantile_alignment.p50!).toBeGreaterThan(quantile_alignment.p75!);
  expect(quantile_alignment.p75!).toBeGreaterThan(quantile_alignment.p95!);
});

test("shows clear error state for failed url input", async ({ page }) => {
  await page.goto("/?input=src/visualize/fixtures/missing.json", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("visualize-root")).toHaveAttribute(
    "data-load-state",
    "error",
  );
  await expect(page.getByTestId("error-state")).toBeVisible();
  await expect(page.getByTestId("error-state")).toContainText(
    "无法读取 input 文件",
  );
});

test("replay button disables while animation is running", async ({ page }) => {
  await page.clock.install();
  await goto_fixture(page, { autoplay: false, fastAnimations: false });
  await expect(page.getByTestId("visualize-root")).toHaveAttribute(
    "data-animation-state",
    "primed",
  );

  const replay_button = page.getByTestId("replay-animation");
  await page.getByTestId("cdf-chart").hover();
  await expect(replay_button).toBeEnabled();
  await replay_button.click();
  await expect(replay_button).toBeDisabled();
  await page.clock.runFor(ANIMATION_IDLE_TIMEOUT_MS); // Advance time to let animation complete
  await expect(page.getByTestId("visualize-root")).toHaveAttribute(
    "data-animation-state",
    "idle",
  );
  await expect(replay_button).toBeEnabled();
});
