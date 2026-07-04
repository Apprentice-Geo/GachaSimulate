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
  await expect(page.getByText("成功概率")).toBeVisible();
  await expect(page.getByText("累计抽数")).toBeVisible();
  await expect(page.getByRole("heading", { name: "低抽数区间" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "中抽数区间" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "高抽数区间" })).toBeVisible();
  await expect(page.getByTestId("statistic-panel")).toBeVisible();
  await expect(page.getByTestId("stat-COST")).toHaveCount(0);
  await expect(page.getByTestId("termination-bar")).toBeVisible();
  await expect(page.locator(".termination-heading h2")).toBeVisible();
  await expect(page.locator(".page-note")).toBeVisible();
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

test("keeps enlarged preview scrollable from the left edge", async ({
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

  await page.setViewportSize({ width: 1536, height: 864 });

  const scroll_contract = await page.evaluate(() => {
    const root = document.querySelector("#root");
    const visualize_root = document.querySelector(
      '[data-testid="visualize-root"]',
    );
    if (
      !(root instanceof HTMLElement) ||
      !(visualize_root instanceof HTMLElement)
    ) {
      return null;
    }

    root.scrollLeft = 0;
    root.scrollTop = 0;

    const root_rect = root.getBoundingClientRect();
    const visualize_rect = visualize_root.getBoundingClientRect();

    return {
      root_client_width: root.clientWidth,
      root_scroll_width: root.scrollWidth,
      root_client_height: root.clientHeight,
      root_scroll_height: root.scrollHeight,
      visualize_left_at_scroll_origin: visualize_rect.left - root_rect.left,
      visualize_top_at_scroll_origin: visualize_rect.top - root_rect.top,
    };
  });

  expect(scroll_contract).not.toBeNull();
  expect(scroll_contract!.root_scroll_width).toBeGreaterThan(
    scroll_contract!.root_client_width,
  );
  expect(scroll_contract!.root_scroll_height).toBeGreaterThan(
    scroll_contract!.root_client_height,
  );
  expect(
    scroll_contract!.visualize_left_at_scroll_origin,
  ).toBeGreaterThanOrEqual(-1);
  expect(
    scroll_contract!.visualize_top_at_scroll_origin,
  ).toBeGreaterThanOrEqual(-1);
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
