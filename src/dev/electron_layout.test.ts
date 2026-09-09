import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

const PROJECT_ROOT = process.cwd();

function repository_fixture(count = 32): ConfigRepositoryState {
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
    await application.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler("list-configs");
      ipcMain.handle("list-configs", () => fixture);
    }, simulation_fixture());
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

async function fail_with_layout(page: Page, message: string): Promise<never> {
  const details = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    zoom: getComputedStyle(
      document.querySelector(".renderer-shell") as HTMLElement,
    ).zoom,
    scroll: Object.fromEntries(
      [
        ".renderer-main",
        '[data-testid="simulation-item-list"]',
        '[data-testid="result-preview-scroll"]',
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
    '[data-testid="result-preview"]',
    '[data-testid="result-preview-scroll"]',
    '[data-testid="result-cdf-preview"]',
    ".repository-page",
  ]);
  throw new Error(
    `${message}: ${JSON.stringify({ ...details, rects: layout_rects })}`,
  );
}

async function assert_layout(
  application: ElectronApplication,
  page: Page,
  width: number,
  height: number,
) {
  await page.getByText("状态 / 待运行").waitFor();
  const expected_zoom = width === 2560 && height === 1440 ? "1.25" : "1";
  assert.equal(
    await page
      .locator(".renderer-shell")
      .evaluate((node) => getComputedStyle(node).zoom),
    expected_zoom,
  );
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

  await page.getByRole("button", { name: "结果可视化" }).click();
  const unavailable_export = page.getByRole("button", { name: "导出素材" });
  await unavailable_export.focus();
  assert.equal(await unavailable_export.getAttribute("aria-disabled"), "true");
  const reason_id = await unavailable_export.getAttribute("aria-describedby");
  assert.ok(reason_id);
  assert.equal(
    await page.locator(`#${reason_id}`).textContent(),
    "请先载入结果后再导出。",
  );

  await page.getByRole("button", { name: "结果编辑" }).click();
  await page.locator("#simulation-title").waitFor({ state: "hidden" });
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
  await page.getByLabel("副标题", { exact: true }).waitFor();
  await page.getByLabel("统计物品展示单位", { exact: true }).waitFor();

  const preview = page.locator('[data-testid="result-preview"]');
  const scroll = page.locator('[data-testid="result-preview-scroll"]');
  const heading = preview.getByRole("heading", { name: "核心指标" });
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
    return {
      aspect_ratio: root_rect.width / root_rect.height,
      fits:
        viewport.scrollWidth <= viewport.clientWidth &&
        viewport.scrollHeight <= viewport.clientHeight &&
        root_rect.left >= viewport_rect.left &&
        root_rect.right <= viewport_rect.right &&
        root_rect.top >= viewport_rect.top &&
        root_rect.bottom <= viewport_rect.bottom,
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
  assert.ok(visualize_contract.fits);
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
      return destination_calls === 1
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
          });
      },
    );
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
  await assert_full_window_host_rects(page);
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
  await page
    .locator('[data-testid="visualize-root"][data-animation-state="playing"]')
    .waitFor();
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
  await page
    .locator('[data-testid="visualize-root"][data-animation-state="playing"]')
    .waitFor();
  await page
    .locator('[data-testid="visualize-root"][data-animation-state="idle"]')
    .waitFor({ timeout: 10_000 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.dataset.animationRestartCount,
    ),
    "2",
  );

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
  const [official_box, local_box] = await Promise.all([
    official.boundingBox(),
    local.boundingBox(),
  ]);
  assert.ok(official_box && local_box);
  assert.ok(official_box.height / local_box.height > 2);
  assert.ok(official_box.height / local_box.height < 2.7);
  assert.equal(
    await repository.evaluate((node) => node.scrollHeight <= node.clientHeight),
    true,
  );

  const official_heading_before = await official
    .locator(".repository-source-heading")
    .boundingBox();
  const local_heading_before = await local
    .locator(".repository-source-heading")
    .boundingBox();
  assert.ok(official_heading_before && local_heading_before);
  for (const list of [
    official.locator(".repository-list"),
    local.locator(".local-config-list"),
  ]) {
    const scroll = await list.evaluate((node) => {
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
    assert.ok(scroll.scrollHeight > scroll.clientHeight);
    assert.ok(scroll.scrollTop > 0);
  }
  assert.deepEqual(
    await official.locator(".repository-source-heading").boundingBox(),
    official_heading_before,
  );
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
}

test("Electron renderer layout contracts hold at both supported sizes", async () => {
  for (const [width, height] of [
    [2560, 1440],
    [1280, 720],
  ] as const) {
    const { application, cdp, config_home, page } = await launch(width, height);
    try {
      await assert_layout(application, page, width, height);
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
  }
});
