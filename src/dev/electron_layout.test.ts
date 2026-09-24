import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  _electron as electron,
  type CDPSession,
  type ElectronApplication,
  type Page,
} from "playwright";
import type { ConfigRepositoryState } from "../shared/installed_config";
import { emulate_viewport } from "./electron_viewport";
import { result_fixture, simulation_fixture } from "./ui_fixtures";
import {
  assert_style_boundaries,
  chart_style,
  assert_export_style,
} from "./ui_style_contract";

const PROJECT_ROOT = process.cwd();

function repository_fixture(count = 80): ConfigRepositoryState {
  return {
    official: Array.from({ length: count }, (_, index) => ({
      id: `config_${index}`,
      name: `测试配置 ${index}`,
      description: "用于检查配置仓库滚动区域。",
      status: "available" as const,
    })),
    localDirectory: "/tmp/gachasimulate-configs",
    localConfigs: Array.from({ length: count }, (_, index) => ({
      id: `local_config_${index}`,
      name: `本地配置 ${index}`,
      description: "用于检查配置仓库滚动区域。",
      source: "local" as const,
      terminations: [{ file: "termination.yaml", name: "完成" }],
      items: [{ id: "draw_count", name: "抽数" }],
    })),
    sourceError: null,
    localError: null,
  };
}

async function launch(width: number, height: number) {
  const config_home = await mkdtemp(
    path.join(tmpdir(), "gachasimulate-layout-"),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  let application: ElectronApplication | undefined;
  let cdp: CDPSession | undefined;
  try {
    application = await electron.launch({
      args: [PROJECT_ROOT],
      cwd: PROJECT_ROOT,
      env: {
        ...env,
        GACHASIMULATE_ELECTRON_OFFSCREEN: "1",
        XDG_CONFIG_HOME: config_home,
      },
    });
    await application.evaluate(
      ({ ipcMain }, fixture) => {
        ipcMain.removeHandler("list-configs");
        ipcMain.handle("list-configs", () => fixture);
      },
      simulation_fixture().map((config) => ({
        ...config,
        items: Array.from({ length: 80 }, (_, index) => ({
          id: `item_${index}`,
          name: `统计物品 ${index}`,
        })),
      })),
    );
    const page = await application.firstWindow();
    const automation_state = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        background_throttling: window?.webContents.getBackgroundThrottling(),
        offscreen: window?.webContents.isOffscreen(),
        visible: window?.isVisible(),
      };
    });
    assert.deepEqual(automation_state, {
      background_throttling: false,
      offscreen: true,
      visible: false,
    });
    const content_size_before = await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentSize(),
    );
    cdp = await emulate_viewport(page, width, height);
    assert.deepEqual(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getContentSize(),
      ),
      content_size_before,
    );
    await page.waitForFunction(
      ([expected_width, expected_height]) =>
        window.innerHeight === expected_height &&
        window.innerWidth === expected_width,
      [width, height],
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    return { application, cdp, config_home, page };
  } catch (error) {
    try {
      await cdp?.detach();
    } finally {
      try {
        await application?.close();
      } finally {
        await rm(config_home, { force: true, recursive: true });
      }
    }
    throw error;
  }
}

function rects(page: Page, selectors: string[]) {
  return page.evaluate(
    (items) =>
      Object.fromEntries(
        items.map((selector) => {
          const element = document.querySelector(selector);
          const rect = element?.getBoundingClientRect();
          return [
            selector,
            rect
              ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              : null,
          ];
        }),
      ),
    selectors,
  );
}

async function assert_full_window_host_rects(page: Page) {
  const host_rects = await rects(page, [
    "#root",
    ".export-background",
    ".renderer-shell",
  ]);
  assert.ok(host_rects["#root"]);
  assert.deepEqual(host_rects[".export-background"], host_rects["#root"]);
  assert.deepEqual(host_rects[".renderer-shell"], host_rects["#root"]);
  assert.deepEqual(
    await page.evaluate(() => ({
      body: document.body.scrollWidth <= document.body.clientWidth,
      document:
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    })),
    { body: true, document: true },
  );
}

async function assert_contained(page: Page, parent: string, child: string) {
  const [outer, inner] = await Promise.all([
    page.locator(parent).boundingBox(),
    page.locator(child).boundingBox(),
  ]);
  assert.ok(outer && inner);
  assert.ok(
    inner.x >= outer.x && inner.y >= outer.y,
    `${child} starts inside ${parent}`,
  );
  assert.ok(
    inner.x + inner.width <= outer.x + outer.width + 1,
    `${child} fits ${parent} width`,
  );
  assert.ok(
    inner.y + inner.height <= outer.y + outer.height + 1,
    `${child} fits ${parent} height`,
  );
}

// Compare normalized geometry so every part of the preview must scale together.
async function chart_geometry(page: Page) {
  return page.locator(".cdf-chart-shell").evaluate((node) => {
    const frame = node.getBoundingClientRect();
    const selectors = [
      ".recharts-xAxis .recharts-cartesian-axis-line",
      ".recharts-yAxis .recharts-cartesian-axis-line",
      ".axis-title",
      ".y-axis-title",
      '[data-marker-key="P50"] .marker-point',
      '[data-marker-key="P50"] .marker-label',
    ];
    return {
      ratio: frame.width / frame.height,
      path: node.querySelector(".cdf-curve-path")!.getAttribute("d"),
      ticks: [
        ...node.querySelectorAll(".recharts-cartesian-axis-tick-value"),
      ].map((tick) => tick.textContent),
      parts: selectors.map((selector) => {
        const part = node.querySelector(selector)!;
        // SVG glyph bounds include font hinting at the final pixel size. Check
        // the text anchor and font scale instead of its rasterized glyph box.
        if (part instanceof SVGTextElement) {
          const matrix = part.getScreenCTM()!;
          const anchor = new DOMPoint(
            Number(part.getAttribute("x")),
            Number(part.getAttribute("y")),
          ).matrixTransform(matrix);
          const font_size = parseFloat(getComputedStyle(part).fontSize);
          return [
            (anchor.x - frame.x) / frame.width,
            (anchor.y - frame.y) / frame.height,
            (font_size * Math.hypot(matrix.a, matrix.b)) / frame.width,
            (font_size * Math.hypot(matrix.c, matrix.d)) / frame.height,
          ];
        }
        const rect = part.getBoundingClientRect();
        return [
          (rect.x - frame.x) / frame.width,
          (rect.y - frame.y) / frame.height,
          rect.width / frame.width,
          rect.height / frame.height,
        ];
      }),
    };
  });
}

async function assert_preview_width(page: Page) {
  await page.waitForFunction(() => {
    const host = document.querySelector(".chart-preview")!;
    const chart = host.querySelector(".cdf-chart-shell")!;
    return (
      Math.abs(
        host.getBoundingClientRect().width -
          chart.getBoundingClientRect().width,
      ) < 0.1
    );
  });
  const geometry = await page.locator(".result-cdf-chart").evaluate((node) => {
    const style = getComputedStyle(node);
    const host = node.querySelector(".chart-preview")!.getBoundingClientRect();
    const chart = node
      .querySelector(".cdf-chart-shell")!
      .getBoundingClientRect();
    return {
      available:
        node.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight),
      width: host.width,
      height: host.height,
      chart_height: chart.height,
      no_horizontal_scroll: node.scrollWidth <= node.clientWidth,
    };
  });
  assert_pixel_equal(
    geometry.width,
    geometry.available,
    "preview uses the content width",
  );
  assert_pixel_equal(
    geometry.height,
    geometry.width / 2,
    "preview reserves its scaled height",
  );
  assert_pixel_equal(
    geometry.chart_height,
    geometry.height,
    "chart fits its preview slot",
  );
  assert.ok(geometry.no_horizontal_scroll);
}

async function assert_scroll_owner(page: Page, selector: string) {
  const result = await page.locator(selector).evaluate((node) => {
    const heading = node.parentElement?.querySelector(".panel-heading");
    const heading_top = heading?.getBoundingClientRect().top;
    node.scrollTop = node.scrollHeight;
    const result = {
      overflow: node.scrollHeight > node.clientHeight,
      top: node.scrollTop,
      heading_stable: heading?.getBoundingClientRect().top === heading_top,
    };
    node.scrollTop = 0;
    return result;
  });
  if (result.overflow)
    assert.ok(result.top > 0, `${selector} can scroll overflowing content`);
  assert.ok(
    result.heading_stable,
    `${selector} leaves its panel heading stationary`,
  );
}

async function assert_page_space(
  page: Page,
  selector: string,
  workbench?: string,
) {
  await assert_full_window_host_rects(page);
  await assert_contained(page, ".renderer-main", selector);
  for (const container of [
    "#root",
    ".renderer-main",
    ".renderer-content",
    selector,
  ]) {
    assert.equal(
      await page
        .locator(container)
        .evaluate(
          (node) =>
            node.scrollHeight <= node.clientHeight &&
            node.scrollWidth <= node.clientWidth &&
            node.scrollTop === 0,
        ),
      true,
      `${container} has no outer overflow or scroll offset`,
    );
  }
  if (workbench) {
    const [heading, body] = await Promise.all([
      vertical_geometry(page, `${selector} > .page-heading`),
      vertical_geometry(page, workbench),
    ]);
    assert_pixel_equal(
      body.top,
      heading.bottom + heading.margin_bottom,
      "workbench starts below page heading",
    );
  }
}

async function capture_layout(page: Page, name: string) {
  if (!process.env.GACHASIMULATE_LAYOUT_CAPTURE) return;
  const { width, height } = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  const directory = path.join(PROJECT_ROOT, "tmp", "ui-captures");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `layout-${name}-${width}x${height}.png`),
  });
}

// Compare rendered geometry without fixing padding or
// panel heights. One physical pixel allows Chromium's subpixel rounding.
async function vertical_geometry(page: Page, selector: string) {
  return page.locator(selector).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const top_inset =
      parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    const bottom_inset =
      parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom);
    return {
      top: rect.top,
      bottom: rect.bottom,
      content_top: rect.top + top_inset,
      content_bottom: rect.bottom - bottom_inset,
      content_height: rect.height - (top_inset + bottom_inset),
      margin_bottom: parseFloat(style.marginBottom),
    };
  });
}

function assert_pixel_equal(actual: number, expected: number, message: string) {
  assert.ok(
    Math.abs(actual - expected) <= 1,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

async function assert_vertical_fill(
  page: Page,
  parent: string,
  first: string,
  last = first,
) {
  const [outer, start, end] = await Promise.all([
    vertical_geometry(page, parent),
    vertical_geometry(page, first),
    vertical_geometry(page, last),
  ]);
  assert_pixel_equal(
    start.top,
    outer.content_top,
    `${first} fills ${parent} top`,
  );
  assert_pixel_equal(
    end.bottom,
    outer.content_bottom,
    `${last} fills ${parent} bottom`,
  );
}

async function assert_repository_space(page: Page, source: string) {
  await assert_vertical_fill(page, ".renderer-main", ".repository-page");
  await assert_vertical_fill(
    page,
    ".repository-page",
    ".repository-header",
    source,
  );
  assert.ok((await vertical_geometry(page, source)).content_height > 0);
}

async function fail_with_layout(page: Page, message: string): Promise<never> {
  const details = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    scroll: Object.fromEntries(
      [
        ".renderer-main",
        '[data-testid="simulation-item-list"]',
        ".result-editor-fields",
        ".repository-page",
      ].map((selector) => {
        const element = document.querySelector(selector) as HTMLElement | null;
        return [
          selector,
          element && {
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            scrollTop: element.scrollTop,
          },
        ];
      }),
    ),
  }));
  const layout_rects = await rects(page, [
    ".renderer-main",
    '[data-testid="simulation-selection"]',
    '[data-testid="simulation-item-list"]',
    ".result-editor-form",
    ".result-editor-fields",
    '[data-testid="result-cdf-preview"]',
    ".repository-page",
  ]);
  throw new Error(
    `${message}: ${JSON.stringify({ ...details, rects: layout_rects })}`,
  );
}

async function assert_layout(application: ElectronApplication, page: Page) {
  await page.getByText("状态 / 待运行").waitFor();
  await page.evaluate(() => document.fonts.ready);
  const visual = await page.evaluate(() => {
    return {
      width: innerWidth,
      font: parseFloat(
        getComputedStyle(document.querySelector(".renderer-shell")!).fontSize,
      ),
      body: parseFloat(
        getComputedStyle(document.querySelector(".config-description")!)
          .fontSize,
      ),
      small: parseFloat(
        getComputedStyle(document.querySelector(".panel-kicker")!).fontSize,
      ),
      sidebar: document
        .querySelector(".renderer-sidebar")!
        .getBoundingClientRect().width,
      control: document
        .querySelector(".simulation-control input")!
        .getBoundingClientRect().height,
      icon: document
        .querySelector(".renderer-nav-button svg")!
        .getBoundingClientRect().width,
    };
  });
  const density =
    Math.min(1.5, Math.max(1, (8 + visual.width * 0.00625) / 16)) * 1.15;
  for (const [actual, expected] of [
    [visual.font, Math.min(27, 9 + visual.width * 0.00703125)],
    [visual.body, 15 * density],
    [visual.small, 12 * density],
    [visual.control, 40 * density],
    [visual.icon, 18 * density],
    [
      visual.sidebar,
      Math.min(158.208, Math.max(79.104, visual.width * 0.0618)),
    ],
  ])
    assert.ok(Math.abs(actual - expected) < 1, JSON.stringify(visual));
  const space_failures: string[] = [];
  const check_space = async (check: () => Promise<void>) => {
    try {
      await check();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      space_failures.push(error.message);
    }
  };
  const simulation = page.locator('[data-testid="simulation-selection"]');
  const list = page.locator('[data-testid="simulation-item-list"]');
  const contained = await simulation.evaluate((parent) => {
    const outer = parent.getBoundingClientRect();
    const inner = (
      parent.querySelector(
        '[data-testid="simulation-item-list"]',
      ) as HTMLElement
    ).getBoundingClientRect();
    return (
      inner.top >= outer.top &&
      inner.left >= outer.left &&
      inner.right <= outer.right &&
      inner.bottom <= outer.bottom
    );
  });
  assert.equal(contained, true);
  await check_space(() =>
    assert_vertical_fill(page, ".renderer-main", ".simulation-page"),
  );
  for (const panel of [".simulation-selection", ".simulation-control"]) {
    await check_space(() =>
      assert_vertical_fill(page, ".simulation-workbench", panel),
    );
  }
  await check_space(async () => {
    const [trace, status] = await Promise.all([
      vertical_geometry(page, ".simulation-trace"),
      vertical_geometry(page, ".simulation-status"),
    ]);
    assert_pixel_equal(
      trace.bottom + trace.margin_bottom,
      status.top,
      "simulation trace fills remaining control space",
    );
    await assert_vertical_fill(
      page,
      ".simulation-trace",
      ".simulation-trace li:first-child",
      ".simulation-trace li:last-child",
    );
  });
  await check_space(() =>
    assert_vertical_fill(
      page,
      ".simulation-page",
      ".simulation-page .page-heading",
      ".simulation-workbench",
    ),
  );
  assert.equal(
    await page
      .locator(".renderer-main")
      .evaluate((node) => node.scrollHeight <= node.clientHeight),
    true,
  );
  assert.equal(
    await list.evaluate((node) => node.scrollHeight > node.clientHeight),
    true,
  );
  await assert_scroll_owner(page, '[data-testid="simulation-item-list"]');
  await assert_scroll_owner(page, ".simulation-control-body");
  await assert_contained(
    page,
    ".simulation-control",
    ".simulation-control-body",
  );
  await assert_page_space(page, ".simulation-page", ".simulation-workbench");
  await capture_layout(page, "simulation");
  const selection_before = await simulation.boundingBox();
  const search = page.getByRole("searchbox", { name: "搜索统计物品" });
  await search.fill("item_79");
  const search_focus = await search.evaluate((node) => ({
    inner: getComputedStyle(node).outlineStyle,
    outer: getComputedStyle(node.parentElement!).outlineStyle,
  }));
  assert.equal(search_focus.inner, "none", "search has no second focus ring");
  assert.equal(search_focus.outer, "solid", "search wrapper indicates focus");
  await capture_layout(page, "search-focus");
  await page.waitForFunction(
    () => document.querySelectorAll(".simulation-item").length === 1,
  );
  assert.deepEqual(await simulation.boundingBox(), selection_before);
  await assert_contained(
    page,
    ".simulation-selection",
    ".simulation-item-panel",
  );
  await search.fill("");

  await page.getByRole("button", { name: "结果可视化" }).click();
  await page.getByRole("button", { name: "选择 GSR" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "导出素材" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "重放动画" }).count(), 0);
  assert.equal(await page.locator(".main-region").count(), 0);
  assert.equal(await page.locator(".visualize-scope").count(), 0);
  assert.equal(await page.locator(".top-bar").count(), 0);
  const visualize_load_style = await page
    .locator(".result-load-panel")
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return [
        style.backgroundColor,
        style.borderTopColor,
        style.color,
        style.fontFamily,
      ];
    });

  await page.getByRole("button", { name: "结果编辑" }).click();
  await page.locator("#simulation-title").waitFor({ state: "hidden" });
  assert.equal(
    await page.getByRole("heading", { name: "结果展示信息" }).count(),
    0,
  );
  assert.equal(await page.locator(".result-editor-header").count(), 0);
  assert.deepEqual(
    await page.locator(".result-load-panel").evaluate((node) => {
      const style = getComputedStyle(node);
      return [
        style.backgroundColor,
        style.borderTopColor,
        style.color,
        style.fontFamily,
      ];
    }),
    visualize_load_style,
  );
  await application.evaluate(({ ipcMain }, fixture) => {
    let calls = 0;
    ipcMain.removeHandler("select-gsr-result");
    ipcMain.handle("select-gsr-result", () => (calls++ === 0 ? null : fixture));
  }, result_fixture());
  const select = page.getByRole("button", { name: "选择 GSR" });
  await select.click();
  await page.getByText("未选择文件。", { exact: true }).waitFor();
  await select.click();
  await page.getByRole("button", { name: "更换 GSR" }).waitFor();
  await page.getByRole("heading", { name: "结果展示信息" }).waitFor();
  await page.getByLabel("副标题", { exact: true }).waitFor();
  await page.getByLabel("统计物品展示单位", { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await assert_vertical_fill(page, ".renderer-main", ".result-editor");
  await assert_vertical_fill(
    page,
    ".result-editor",
    ".result-editor-header",
    ".result-save-status",
  );
  for (const panel of [".result-editor-form", ".result-cdf-preview"]) {
    await assert_vertical_fill(page, ".result-editor-workbench", panel);
  }
  await assert_vertical_fill(
    page,
    ".result-editor-form",
    ".result-editor-form .panel-heading",
    ".result-editor-fields",
  );
  await assert_scroll_owner(page, ".result-editor-fields");
  assert.equal(
    await page.getByRole("heading", { name: "核心指标" }).count(),
    0,
  );
  assert.deepEqual(
    await page.locator(".result-editor-summary dt").allTextContents(),
    ["结果指标", "累计模拟次数", "累计次数"],
  );
  assert.equal(
    await page.locator(".result-editor-summary code").textContent(),
    result_fixture().analysis.result_item.id,
  );
  const total_summary = page.locator(".result-editor-summary dd").nth(2);
  const total_number = Number(
    result_fixture().analysis.totals.result,
  ).toLocaleString("zh-CN");
  const unit_input = page.getByLabel("统计物品展示单位", { exact: true });
  const original_unit = await unit_input.inputValue();
  for (const unit of ["", "份 / 次", original_unit]) {
    await unit_input.fill(unit);
    assert.equal(
      await total_summary.textContent(),
      total_number + (unit ? ` ${unit}` : ""),
      "Workbench summary preserves the value and reflects unit edits",
    );
  }
  const summary_boxes = await page
    .locator(".result-editor-summary > div")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right };
      }),
    );
  for (let i = 1; i < summary_boxes.length; i++) {
    assert_pixel_equal(
      summary_boxes[i].y,
      summary_boxes[0].y,
      "summary items share a row",
    );
    assert.ok(summary_boxes[i].x >= summary_boxes[i - 1].right);
  }
  const field_boxes = await page
    .locator(".result-editor-fields textarea")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, bottom: r.bottom };
      }),
    );
  assert.equal(field_boxes.length, 6);
  for (let i = 1; i < field_boxes.length; i++) {
    assert_pixel_equal(field_boxes[i].x, field_boxes[0].x, "fields align left");
    assert_pixel_equal(
      field_boxes[i].width,
      field_boxes[0].width,
      "fields share full width",
    );
    assert.ok(field_boxes[i].y >= field_boxes[i - 1].bottom);
  }
  await assert_page_space(page, ".result-editor", ".result-editor-workbench");
  const [workbench_end, save_status] = await Promise.all([
    vertical_geometry(page, ".result-editor-workbench"),
    page.locator(".result-save-status").evaluate((node) => ({
      top: node.getBoundingClientRect().top,
      margin: parseFloat(getComputedStyle(node).marginTop),
    })),
  ]);
  assert_pixel_equal(
    workbench_end.bottom,
    save_status.top - save_status.margin,
    "editor workbench fills space above save status",
  );
  await capture_layout(page, "editor");
  const note = page.getByLabel("说明", { exact: true });
  const original_note = await note.inputValue();
  await note.focus();
  const focus_geometry = await note.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      style: style.outlineStyle,
      extent: parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset),
      gap: parseFloat(
        getComputedStyle(node.closest(".result-editor-fields")!)
          .paddingInlineEnd,
      ),
    };
  });
  assert.equal(focus_geometry.style, "solid");
  assert.ok(focus_geometry.extent <= 0, "field focus stays within its border");
  assert.ok(focus_geometry.gap > 0, "fields leave space beside the scrollbar");
  const short_height = (await note.boundingBox())!.height;
  const long_note = "长说明文本用于验证自动换行与高度调整。".repeat(100);
  await note.fill(long_note);
  const long_geometry = await note.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  assert.ok(long_geometry.height > short_height, "long text grows the field");
  assert.ok(
    long_geometry.scrollHeight > long_geometry.clientHeight,
    "very long text scrolls within the bounded field",
  );
  assert.ok(
    long_geometry.scrollWidth <= long_geometry.clientWidth,
    "long text wraps without horizontal clipping",
  );
  assert.equal(
    await note.inputValue(),
    long_note,
    "soft wrapping preserves text",
  );
  await capture_layout(page, "editor-long-text");
  await note.fill(original_note);
  assert_pixel_equal(
    (await note.boundingBox())!.height,
    short_height,
    "field shrinks when long text is removed",
  );
  const scroll = page.locator(".result-editor-fields");
  const heading = page.getByRole("heading", { name: "可视化文案" });
  const summary_before = await page
    .locator(".result-editor-summary")
    .boundingBox();
  const before = await heading.boundingBox();
  assert.ok(before);
  assert.equal(
    await scroll.evaluate((node) => node.scrollHeight >= node.clientHeight),
    true,
  );
  await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  assert.deepEqual(await heading.boundingBox(), before);
  assert.deepEqual(
    await page.locator(".result-editor-summary").boundingBox(),
    summary_before,
  );
  assert.equal(
    await page
      .locator('[data-testid="result-cdf-preview"]')
      .evaluate(
        (node) =>
          node.scrollWidth <= node.clientWidth &&
          node.scrollHeight <= node.clientHeight,
      ),
    true,
  );
  assert.ok(
    await page.locator('[data-testid="result-cdf-preview"] circle').count(),
  );

  await assert_vertical_fill(
    page,
    ".result-cdf-preview",
    ".result-cdf-preview .panel-heading",
    ".result-cdf-chart",
  );
  await assert_preview_width(page);
  const preview_geometry = await chart_geometry(page);
  const preview_style = await assert_style_boundaries(page);
  assert.ok(Math.abs(preview_geometry.ratio - 2) < 0.00001);

  // Container-only resizing must work without a window resize event.
  await page.locator(".result-cdf-chart").evaluate((node) => {
    (node as HTMLElement).style.width = "75%";
  });
  await assert_preview_width(page);
  const narrowed_geometry = await chart_geometry(page);
  assert.deepEqual(narrowed_geometry.ticks, preview_geometry.ticks);
  assert.equal(narrowed_geometry.path, preview_geometry.path);
  for (let i = 0; i < preview_geometry.parts.length; i++) {
    for (let j = 0; j < 4; j++) {
      assert.ok(
        Math.abs(narrowed_geometry.parts[i][j] - preview_geometry.parts[i][j]) <
          0.0001,
        `part ${i} coordinate ${j}: ${JSON.stringify({ before: preview_geometry.parts[i], after: narrowed_geometry.parts[i] })}`,
      );
    }
  }
  await page.locator(".result-cdf-chart").evaluate((node) => {
    (node as HTMLElement).style.removeProperty("width");
  });
  await assert_preview_width(page);

  // Populate additional preview slots to exercise the stack and scroll owner.
  await page.locator(".result-cdf-chart").evaluate((node) => {
    const first = node.firstElementChild!;
    for (let i = 0; i < 3; i++) node.append(first.cloneNode(true));
  });
  const slots = await page.locator(".chart-preview").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
      };
    }),
  );
  for (let i = 1; i < slots.length; i++) {
    assert.ok(
      slots[i].top > slots[i - 1].bottom,
      "preview slots stack with a gap",
    );
    assert_pixel_equal(
      slots[i].left,
      slots[0].left,
      "preview slots align left",
    );
    assert_pixel_equal(
      slots[i].width,
      slots[0].width,
      "preview slots share available width",
    );
  }
  assert.equal(
    await page
      .locator(".result-cdf-chart")
      .evaluate((node) => node.scrollHeight > node.clientHeight),
    true,
  );
  await assert_scroll_owner(page, ".result-cdf-chart");
  await assert_preview_width(page);
  await capture_layout(page, "editor-stacked-previews");
  await page.locator(".result-cdf-chart").evaluate((node) => {
    while (node.children.length > 1) node.lastElementChild!.remove();
  });

  await page.getByRole("button", { name: "结果可视化" }).click();
  const visualization = page.locator('[data-testid="visualize-root"]');
  await visualization.waitFor();
  await page
    .locator('[data-testid="visualize-root"][data-animation-state="idle"]')
    .waitFor({ timeout: 10_000 });
  await assert_full_window_host_rects(page);
  await page.evaluate(() => {
    document.documentElement.dataset.animationRestartCount = "0";
    new MutationObserver(() => {
      if (document.documentElement.dataset.visualizeAnimation === "playing") {
        const count = Number(
          document.documentElement.dataset.animationRestartCount ?? "0",
        );
        document.documentElement.dataset.animationRestartCount = String(
          count + 1,
        );
      }
    }).observe(document.documentElement, {
      attributeFilter: ["data-visualize-animation"],
      attributes: true,
    });
  });
  assert.match(
    (await page.getByTestId("cdf-curve-path").getAttribute("d")) ?? "",
    /^M/,
  );
  assert.equal(await page.locator(".pk-segment").count(), 3);
  assert.equal(
    await page.getByTestId("stat-P50").locator(".metric-value").textContent(),
    "39 抽",
  );
  const axis_tick_text = await page
    .locator(".cdf-chart-shell .recharts-cartesian-axis-tick-value")
    .allTextContents();
  assert.ok(axis_tick_text.length > 0);
  assert.equal(
    axis_tick_text.some((text) => text.includes("抽")),
    false,
  );
  const scene_geometry = await chart_geometry(page);
  assert.equal(
    await page.locator(".visualize-viewport.visualize-scope").count(),
    1,
  );
  assert.deepEqual(await chart_style(page), preview_style);
  await assert_export_style(application, preview_style);
  assert.equal(scene_geometry.path, preview_geometry.path);
  assert.deepEqual(scene_geometry.ticks, preview_geometry.ticks);
  for (let i = 0; i < preview_geometry.parts.length; i++) {
    for (let j = 0; j < 4; j++) {
      assert.ok(
        Math.abs(scene_geometry.parts[i][j] - preview_geometry.parts[i][j]) <
          0.0001,
        `preview part ${i} coordinate ${j} matches the formal chart: ${JSON.stringify({ preview: preview_geometry.parts[i], scene: scene_geometry.parts[i] })}`,
      );
    }
  }
  const design_regions = await page.evaluate(() => {
    const selectors = [
      ".chart-region",
      ".cdf-chart-shell",
      ".termination-region",
      ".statistic-panel",
    ];
    return selectors.map((selector) => {
      const node = document.querySelector(selector) as HTMLElement;
      return {
        width: node.offsetWidth,
        height: node.offsetHeight,
        left: node.getBoundingClientRect().left,
      };
    });
  });
  assert.deepEqual(
    design_regions.map(({ width, height }) => [width, height]),
    [
      [2800, 1400],
      [2800, 1400],
      [2800, 280],
      [716, 1720],
    ],
  );
  assert.equal(design_regions[0].left, design_regions[2].left);
  const visualize_contract = await page.evaluate(() => {
    const viewport = document.querySelector(".visualize-viewport");
    const root = document.querySelector('[data-testid="visualize-root"]');
    const line = document.querySelector('[data-marker-key="P50"] .marker-line');
    const point = document.querySelector(
      '[data-marker-key="P50"] .marker-point',
    );
    const regions = [
      ".chart-region",
      ".statistic-panel",
      ".termination-region",
      ".page-note",
    ].map((selector) => document.querySelector(selector));
    if (
      !(viewport instanceof HTMLElement) ||
      !(root instanceof HTMLElement) ||
      !line ||
      !point ||
      regions.some((region) => !(region instanceof HTMLElement))
    )
      return null;
    const viewport_rect = viewport.getBoundingClientRect();
    const root_rect = root.getBoundingClientRect();
    const viewport_style = getComputedStyle(viewport);
    const inset = {
      left: Number.parseFloat(viewport_style.paddingLeft),
      right: Number.parseFloat(viewport_style.paddingRight),
      top: Number.parseFloat(viewport_style.paddingTop),
      bottom: Number.parseFloat(viewport_style.paddingBottom),
    };
    return {
      aspect_ratio: root_rect.width / root_rect.height,
      geometry: {
        inset,
        viewport: {
          client_width: viewport.clientWidth,
          client_height: viewport.clientHeight,
          scroll_width: viewport.scrollWidth,
          scroll_height: viewport.scrollHeight,
          left: viewport_rect.left,
          right: viewport_rect.right,
          top: viewport_rect.top,
          bottom: viewport_rect.bottom,
        },
        root: {
          left: root_rect.left,
          right: root_rect.right,
          top: root_rect.top,
          bottom: root_rect.bottom,
          width: root_rect.width,
          height: root_rect.height,
        },
      },
      fits:
        viewport.scrollWidth <= viewport.clientWidth &&
        viewport.scrollHeight <= viewport.clientHeight &&
        root_rect.left >= viewport_rect.left &&
        root_rect.right <= viewport_rect.right &&
        root_rect.top >= viewport_rect.top &&
        root_rect.bottom <= viewport_rect.bottom,
      gutter_preserved:
        root_rect.left >= viewport_rect.left + inset.left &&
        root_rect.right <= viewport_rect.right - inset.right &&
        root_rect.top >= viewport_rect.top + inset.top &&
        root_rect.bottom <= viewport_rect.bottom - inset.bottom,
      marker_aligned:
        Number(line.getAttribute("x1")) === Number(point.getAttribute("cx")) &&
        Number(line.getAttribute("y2")) === Number(point.getAttribute("cy")),
      regions_visible: regions.every((region) => {
        const rect = (region as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }),
    };
  });
  assert.ok(visualize_contract);
  assert.ok(
    visualize_contract.fits,
    JSON.stringify(visualize_contract.geometry),
  );
  assert.ok(
    visualize_contract.gutter_preserved,
    JSON.stringify(visualize_contract.geometry),
  );
  assert.ok(visualize_contract.marker_aligned);
  assert.ok(visualize_contract.regions_visible);
  assert.ok(Math.abs(visualize_contract.aspect_ratio - 16 / 9) < 0.00001);

  await application.evaluate(({ BrowserWindow, ipcMain }) => {
    let destination_calls = 0;
    for (const channel of [
      "prepare-export",
      "select-export-destination",
      "confirm-export-overwrite",
      "cancel-export",
      "retry-export-cleanup",
      "open-export-directory",
      "exit-after-export-cleanup",
    ])
      ipcMain.removeHandler(channel);
    ipcMain.handle("prepare-export", () => {
      setTimeout(
        () =>
          BrowserWindow.getAllWindows()[0]?.webContents.send("export-event", {
            type: "preparation-ready",
            reservation_id: "ui-reservation",
          }),
        0,
      );
      return { reservation_id: "ui-reservation" };
    });
    ipcMain.handle("select-export-destination", () => {
      destination_calls += 1;
      return destination_calls % 2 === 1
        ? { status: "overwrite-required", files: ["example.mp4"] }
        : { status: "started", task_id: "ui-task" };
    });
    ipcMain.handle("confirm-export-overwrite", () => ({
      status: "started",
      task_id: "ui-task",
    }));
    ipcMain.handle(
      "cancel-export",
      (_event, request: Record<string, string>) => {
        if (request.reservation_id)
          BrowserWindow.getAllWindows()[0]?.webContents.send("export-event", {
            type: "preparation-cancelled",
            reservation_id: request.reservation_id,
            reason: request.reason,
          });
        else
          BrowserWindow.getAllWindows()[0]?.webContents.send("export-event", {
            type: "cancelled",
            task_id: request.task_id,
            saved: [],
            failed: [],
            cleanup_status: "clean",
            residual_files: [],
          });
      },
    );
    ipcMain.handle("retry-export-cleanup", () => undefined);
    ipcMain.handle("open-export-directory", () => undefined);
    ipcMain.handle("exit-after-export-cleanup", () => undefined);
  });

  const chart_actions = page.locator(".chart-actions");
  await page.locator(".chart-region").hover();
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".chart-actions")!).opacity ===
      "1",
  );
  const action_labels = await chart_actions
    .getByRole("button")
    .allTextContents();
  assert.deepEqual(
    action_labels.map((label) => label.trim()),
    ["", "导出素材", "选择结果"],
  );
  const export_button = page.getByRole("button", { name: "导出素材" });
  await export_button.focus();
  assert.equal(
    await chart_actions.evaluate((node) => getComputedStyle(node).opacity),
    "1",
  );
  await export_button.click();
  const dialog = page.getByRole("dialog", { name: "导出素材" });
  await dialog.waitFor();
  await capture_layout(page, "export");
  await assert_full_window_host_rects(page);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await export_button.click();
  await page.getByRole("button", { name: "选择导出目录" }).click();
  await page.getByRole("button", { name: "覆盖并导出" }).click();
  await page.getByRole("dialog", { name: "正在导出素材" }).waitFor();
  await application.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0]?.webContents;
    target?.send("export-event", {
      type: "progress",
      task_id: "ui-task",
      stage: "rendering",
      completed: 57,
      total: 60,
      png_written: true,
    });
  });
  await page
    .locator(".export-stage-copy")
    .getByText("正在渲染第 57 / 60 帧", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("progressbar", { name: "导出帧进度" })
      .getAttribute("value"),
    "57",
  );
  await page.getByText("PNG：静帧已写入", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".export-live").textContent(),
    "正在渲染第 57 / 60 帧",
  );
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("export-event", {
      type: "failed",
      task_id: "ui-task",
      message: "PNG 提交失败",
      saved: [{ format: "mp4", file_name: "example.mp4" }],
      failed: ["png"],
      cleanup_status: "clean",
      residual_files: [],
    });
  });
  const partial_notice = page.locator(".export-notice");
  await partial_notice.getByText("已保存：MP4", { exact: true }).waitFor();
  await partial_notice.getByText("失败：PNG", { exact: true }).waitFor();
  await partial_notice
    .getByRole("button", { name: "打开所在文件夹" })
    .waitFor();

  await export_button.click();
  await page.getByRole("button", { name: "选择导出目录" }).click();
  await page.getByRole("dialog", { name: "正在导出素材" }).waitFor();
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("export-event", {
      type: "completed",
      task_id: "ui-task",
      saved: [
        { format: "mp4", file_name: "example.mp4" },
        { format: "png", file_name: "example.png" },
      ],
      failed: [],
      cleanup_status: "blocked",
      cleanup_message: "example.backup.png 正被占用",
      residual_files: ["example.backup.png"],
    });
  });
  const cleanup_dialog = page.getByRole("dialog", {
    name: "导出资源清理失败",
  });
  await cleanup_dialog.waitFor();
  await cleanup_dialog
    .getByRole("list", { name: "残留文件" })
    .getByText("example.backup.png", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await cleanup_dialog.waitFor();
  assert.equal(
    await page.locator(".export-background").getAttribute("inert"),
    "",
  );
  await cleanup_dialog.getByRole("button", { name: "重试清理" }).click();
  await cleanup_dialog.getByRole("button", { name: "正在清理…" }).waitFor();
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("export-event", {
      type: "cleanup-completed",
      task_id: "ui-task",
    });
  });
  await cleanup_dialog.waitFor({ state: "hidden" });
  await page
    .getByText("文件已保存，导出资源现已清理", { exact: true })
    .waitFor();
  await export_button.click();
  await dialog.waitFor();
  const name_input = page.getByLabel("文件名", { exact: true });
  assert.equal(await name_input.inputValue(), "example");
  assert.equal(
    await name_input.evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(await page.getByLabel("MP4 动画").isChecked(), true);
  assert.equal(await page.getByLabel("PNG 静帧").isChecked(), true);
  await page.getByLabel("PNG 静帧").uncheck();
  await page.getByLabel("PNG 静帧").check();
  await name_input.fill("example-updated");
  await name_input.fill("example");
  assert.equal(
    await page.locator(".export-background").getAttribute("inert"),
    "",
  );
  await page.locator(".export-overlay").click({ position: { x: 4, y: 4 } });
  await dialog.waitFor();
  await page.getByRole("button", { name: "关闭导出" }).focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "选择导出目录" })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await export_button.evaluate((node) => node === document.activeElement),
    true,
  );

  await export_button.click();
  await page.getByRole("button", { name: "选择导出目录" }).click();
  const overwrite = page.getByRole("dialog", { name: "覆盖现有文件？" });
  await overwrite.waitFor();
  await page.getByText("example.mp4", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "返回", exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor();
  assert.equal(await name_input.inputValue(), "example");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-action") ===
      "choose-directory",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "选择导出目录" })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.getByRole("button", { name: "选择导出目录" }).click();
  await page.getByRole("dialog", { name: "正在导出素材" }).waitFor();
  assert.equal(
    await page.locator(".export-background").getAttribute("inert"),
    "",
  );
  await page.getByRole("button", { name: "取消导出" }).click();
  await page.getByRole("dialog", { name: "确定取消导出？" }).waitFor();
  await page.getByRole("button", { name: "确定取消" }).click();
  await page.getByText("已取消导出", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".export-background").getAttribute("inert"),
    null,
  );
  await assert_full_window_host_rects(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.dataset.animationRestartCount,
    ),
    "0",
  );

  await page.getByRole("button", { name: "重新绘制动画" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.animationRestartCount === "1",
    undefined,
    { timeout: 10_000 },
  );
  await page
    .locator('[data-testid="visualize-root"][data-animation-state="idle"]')
    .waitFor({ timeout: 10_000 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.dataset.animationRestartCount,
    ),
    "1",
  );

  await page.getByRole("button", { name: "选择结果" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.animationRestartCount === "2",
    undefined,
    { timeout: 10_000 },
  );
  await page
    .locator('[data-testid="visualize-root"][data-animation-state="idle"]')
    .waitFor({ timeout: 10_000 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.dataset.animationRestartCount,
    ),
    "2",
  );

  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("select-gsr-result");
    ipcMain.handle("select-gsr-result", () => {
      throw new Error("无效的 GSR");
    });
  });
  await page.getByRole("button", { name: "选择结果" }).click();
  const feedback = page.locator(".result-visualize-feedback");
  await feedback
    .getByRole("alert")
    .getByText(/无效的 GSR/)
    .waitFor();
  assert.equal(await visualization.isVisible(), true);
  assert.equal(await feedback.getByRole("status").textContent(), "分析失败。");

  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("select-gsr-result");
    ipcMain.handle("select-gsr-result", () => null);
  });
  await page.getByRole("button", { name: "选择结果" }).click();
  await feedback.getByRole("status").getByText("未选择文件。").waitFor();
  assert.equal(await feedback.getByRole("alert").count(), 0);

  await application.evaluate(({ ipcMain }, fixture) => {
    for (const channel of [
      "get-config-repository-state",
      "refresh-config-repository",
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => fixture);
    }
  }, repository_fixture());
  await page.getByRole("button", { name: "配置仓库" }).click();
  await page.getByText("测试配置 0").waitFor();

  const repository = page.locator(".repository-page");
  const official = page.locator(".official-source");
  const local = page.locator(".local-source");
  const official_box = await official.boundingBox();
  assert.ok(official_box);
  assert.equal(await local.count(), 0);
  assert.deepEqual(
    await repository.locator(".repository-overview dt").allTextContents(),
    ["已安装", "可更新", "可安装"],
  );
  await assert_repository_space(page, ".official-source");
  await capture_layout(page, "repository");
  await assert_page_space(page, ".repository-page");
  assert.equal(
    await repository.evaluate((node) => node.scrollHeight <= node.clientHeight),
    true,
  );

  const official_heading_before = await official
    .locator(".repository-source-heading")
    .boundingBox();
  assert.ok(official_heading_before);
  const official_scroll = await official
    .locator(".repository-list")
    .evaluate((node) => {
      const element = node as HTMLElement;
      const result = {
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollTop: 0,
      };
      element.scrollTop = element.scrollHeight;
      result.scrollTop = element.scrollTop;
      return result;
    });
  assert.ok(official_scroll.scrollHeight > official_scroll.clientHeight);
  assert.ok(official_scroll.scrollTop > 0);
  assert.deepEqual(
    await official.locator(".repository-source-heading").boundingBox(),
    official_heading_before,
  );

  await page.getByRole("button", { name: "本地目录", exact: true }).click();
  await page.getByText("本地配置 0").waitFor();
  assert.equal(await official.count(), 0);
  assert.deepEqual(
    await repository.locator(".repository-overview dt").allTextContents(),
    ["配置数"],
  );
  await page.getByRole("button", { name: "选择本地目录" }).waitFor();
  const local_box = await local.boundingBox();
  assert.ok(local_box);
  await assert_repository_space(page, ".local-source");
  await capture_layout(page, "repository-local");
  const local_heading_before = await local
    .locator(".repository-source-heading")
    .boundingBox();
  assert.ok(local_heading_before);
  const local_scroll = await local
    .locator(".local-config-list")
    .evaluate((node) => {
      const element = node as HTMLElement;
      const result = {
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollTop: 0,
      };
      element.scrollTop = element.scrollHeight;
      result.scrollTop = element.scrollTop;
      return result;
    });
  assert.ok(local_scroll.scrollHeight > local_scroll.clientHeight);
  assert.ok(local_scroll.scrollTop > 0);
  assert.deepEqual(
    await local.locator(".repository-source-heading").boundingBox(),
    local_heading_before,
  );

  await application.evaluate(({ ipcMain }, fixture) => {
    for (const channel of [
      "get-config-repository-state",
      "refresh-config-repository",
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => fixture);
    }
  }, repository_fixture(1));
  await page.getByRole("button", { name: "运行模拟" }).click();
  await page.getByRole("button", { name: "配置仓库" }).click();
  await page.getByText("测试配置 0").waitFor();
  const [list_box, card_box] = await Promise.all([
    official.locator(".repository-list").boundingBox(),
    official.locator(".repository-card").boundingBox(),
  ]);
  assert.ok(list_box && card_box);
  assert.ok(card_box.height < list_box.height);
  await assert_repository_space(page, ".official-source");
  assert.deepEqual(await official.boundingBox(), official_box);
  assert.equal(await local.count(), 0);
  assert.equal(space_failures.length, 0, space_failures.join("\n"));
}

for (const [width, height] of [
  [2560, 1440],
  [1280, 720],
  [1600, 900],
  [2560, 900],
] as const) {
  test(`Electron renderer layout contracts hold at ${width}x${height}`, async () => {
    const { application, cdp, config_home, page } = await launch(width, height);
    try {
      await assert_layout(application, page);
    } catch (error) {
      await fail_with_layout(
        page,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
    } finally {
      try {
        await cdp.detach();
      } finally {
        try {
          await application.close();
        } finally {
          await rm(config_home, { force: true, recursive: true });
        }
      }
    }
  });
}
