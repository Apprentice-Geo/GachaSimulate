import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import type { ConfigRepositoryState } from "../shared/installed_config";
import { result_fixture, simulation_fixture } from "./ui_fixtures";

const PROJECT_ROOT = process.cwd();

function repository_fixture(): ConfigRepositoryState {
  return {
    official: Array.from({ length: 32 }, (_, index) => ({
      id: `config_${index}`,
      name: `测试配置 ${index}`,
      description: "用于检查配置仓库滚动区域。",
      status: "available" as const,
    })),
    localDirectory: "/tmp/gachasimulate-configs",
    localConfigs: Array.from({ length: 32 }, (_, index) => ({
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
  try {
    application = await electron.launch({
      args: [PROJECT_ROOT],
      cwd: PROJECT_ROOT,
      env: { ...env, XDG_CONFIG_HOME: config_home },
    });
    await application.evaluate(
      ({ BrowserWindow, ipcMain }, payload) => {
        ipcMain.removeHandler("list-configs");
        ipcMain.handle("list-configs", () => payload.fixture);
        BrowserWindow.getAllWindows()[0]?.setContentSize(
          payload.width,
          payload.height,
        );
      },
      { fixture: simulation_fixture(), width, height },
    );
    const page = await application.firstWindow();
    await page.waitForFunction(
      ([expected_width, expected_height]) =>
        window.innerWidth === expected_width &&
        window.innerHeight === expected_height,
      [width, height],
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    return { application, config_home, page };
  } catch (error) {
    await application?.close();
    await rm(config_home, { force: true, recursive: true });
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
  assert.ok(official_box.height > local_box.height * 3);
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
}

test("Electron renderer layout contracts hold at both supported sizes", async () => {
  for (const [width, height] of [
    [2560, 1440],
    [1280, 720],
  ] as const) {
    const { application, config_home, page } = await launch(width, height);
    try {
      await assert_layout(application, page, width, height);
    } catch (error) {
      await fail_with_layout(
        page,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await application.close();
      await rm(config_home, { force: true, recursive: true });
    }
  }
});
