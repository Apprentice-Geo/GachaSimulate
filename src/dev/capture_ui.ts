import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  _electron as electron,
  chromium,
  type Browser,
  type ElectronApplication,
  type Page,
} from "playwright";
import { createServer } from "vite";
import input from "../visualize/fixtures/example_input.json";
import type { ResultEditorState } from "../shared/result_editor";
import type { ConfigRepositoryState } from "../shared/installed_config";
import type { VisualizeInput } from "../visualize/types/visualize_input";

const PROJECT_ROOT = process.cwd();
const OUTPUT_DIR = path.join(PROJECT_ROOT, "tmp", "ui-captures");
const WEB_PORT = 5173;
const SCENARIOS = [
  "electron/simulation-idle",
  "electron/simulation-navigation",
  "electron/config-repository",
  "electron/result-editor-loaded",
  "electron/result-visualize-loaded",
  "web/result-visualize-loaded",
] as const;

type Scenario = (typeof SCENARIOS)[number];

function output_path(scenario: Scenario): string {
  return path.join(OUTPUT_DIR, `${scenario.replace("/", "--")}.png`);
}

async function screenshot(page: Page, scenario: Scenario): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const destination = output_path(scenario);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    path: destination,
  });
  console.log(destination);
}

async function wait_for_visualization(page: Page): Promise<void> {
  await page
    .locator(
      '[data-testid="visualize-root"][data-load-state="ready"][data-animation-state="playing"]',
    )
    .waitFor({ timeout: 10_000 });
  await page
    .locator(
      '[data-testid="visualize-root"][data-load-state="ready"][data-animation-state="idle"]',
    )
    .waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const viewport = document.querySelector(".visualize-viewport");
    return (
      viewport instanceof HTMLElement &&
      viewport.scrollWidth <= viewport.clientWidth &&
      viewport.scrollHeight <= viewport.clientHeight
    );
  });
}

function result_fixture(): ResultEditorState {
  const fixture = input as VisualizeInput;
  return {
    path: "/tmp/example.gsr",
    filename: "example.gsr",
    fields: {
      title: fixture.title,
      target: fixture.target,
      note: fixture.note,
      price: fixture.price,
      unit: fixture.unit,
    },
    input: fixture,
    sidecar_path: "/tmp/example.visualize.json",
  };
}

function repository_fixture(): ConfigRepositoryState {
  return {
    official: [
      {
        id: "genshin_character",
        name: "原神角色祈愿",
        description: "角色活动祈愿概率与保底规则。",
        status: "installed",
      },
      {
        id: "starrail_character",
        name: "崩坏：星穹铁道角色跃迁",
        description: "角色活动跃迁概率与保底规则。",
        status: "update_available",
      },
      {
        id: "zzz_character",
        name: "绝区零独家频段",
        description: "独家频段概率与保底规则。",
        status: "available",
      },
    ],
    localDirectory: "/home/user/gachasimulate-configs",
    localConfigs: [
      {
        id: "sandbox",
        name: "开发测试池",
        description: "本地开发配置",
        source: "local",
        terminations: [{ file: "termination.yaml", name: "完成" }],
        items: [{ id: "draw_count", name: "抽数" }],
      },
    ],
    sourceError: null,
    localError: null,
  };
}

async function capture_electron(scenarios: Scenario[]): Promise<void> {
  const config_home = await mkdtemp(
    path.join(tmpdir(), "gachasimulate-ui-config-"),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;

  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch({
      args: [PROJECT_ROOT],
      cwd: PROJECT_ROOT,
      env: { ...env, XDG_CONFIG_HOME: config_home },
    });
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1920, 1080);
    });
    await page.waitForFunction(
      () => window.innerWidth === 1920 && window.innerHeight === 1080,
    );
    await page.reload({ waitUntil: "domcontentloaded" });

    if (scenarios.includes("electron/simulation-idle")) {
      await page.getByText("状态：待运行").waitFor();
      await screenshot(page, "electron/simulation-idle");
    }

    if (scenarios.includes("electron/simulation-navigation")) {
      await page.getByRole("button", { name: "结果编辑" }).click();
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send("simulation-event", {
          status: "completed",
          event: {
            type: "completed",
            result_path: "/tmp/completed-while-away.gsr",
            total_runs: 1,
            total_result: 1,
          },
        });
      });
      await page.getByRole("button", { name: "运行模拟" }).click();
      await page.getByText("结果：completed-while-away.gsr").waitFor();
      await screenshot(page, "electron/simulation-navigation");
    }

    if (scenarios.includes("electron/config-repository")) {
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
      await page.getByText("原神角色祈愿").waitFor();
      await screenshot(page, "electron/config-repository");
    }

    const result_scenarios = scenarios.filter((scenario) =>
      scenario.startsWith("electron/result-"),
    );
    if (result_scenarios.length === 0) return;

    await application.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler("select-gsr-result");
      ipcMain.handle("select-gsr-result", () => fixture);
    }, result_fixture());
    await page.getByRole("button", { name: "结果编辑" }).click();
    await page.locator("#simulation-title").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "选择 GSR" }).click();
    await page.getByText("文件：example.gsr").waitFor();

    if (scenarios.includes("electron/result-editor-loaded")) {
      await screenshot(page, "electron/result-editor-loaded");
    }
    if (scenarios.includes("electron/result-visualize-loaded")) {
      await page.getByRole("button", { name: "结果可视化" }).click();
      await wait_for_visualization(page);
      await screenshot(page, "electron/result-visualize-loaded");
    }
  } finally {
    await application?.close();
    await rm(config_home, { force: true, recursive: true });
  }
}

async function capture_web(): Promise<void> {
  const server = await createServer({
    configFile: path.join(PROJECT_ROOT, "vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: WEB_PORT,
      strictPort: true,
    },
  });
  await server.listen();
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { height: 2160, width: 3840 },
    });
    await page.goto(
      `http://127.0.0.1:${WEB_PORT}/?input=src/visualize/fixtures/example_input.json`,
      { waitUntil: "domcontentloaded" },
    );
    await wait_for_visualization(page);
    await screenshot(page, "web/result-visualize-loaded");
  } finally {
    await browser?.close();
    await server.close();
  }
}

async function main(): Promise<void> {
  const [requested = "all", ...extra] = process.argv.slice(2);
  if (
    extra.length > 0 ||
    (requested !== "all" && !SCENARIOS.includes(requested as Scenario))
  ) {
    throw new Error(`Usage: pnpm run capture:ui [all|${SCENARIOS.join("|")}]`);
  }

  const scenarios =
    requested === "all" ? [...SCENARIOS] : [requested as Scenario];
  await mkdir(OUTPUT_DIR, { recursive: true });

  const electron_scenarios = scenarios.filter((scenario) =>
    scenario.startsWith("electron/"),
  );
  if (electron_scenarios.length > 0) {
    await capture_electron(electron_scenarios);
  }
  if (scenarios.includes("web/result-visualize-loaded")) {
    await capture_web();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
