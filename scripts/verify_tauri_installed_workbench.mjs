import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function runPwsh(script, extraEnv = undefined) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return execFileSync("pwsh", ["-NoProfile", "-EncodedCommand", encoded], {
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    stdio: "inherit",
  });
}

function checkNoPreexistingInstall() {
  runPwsh(`
$p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
if (Test-Path $p) {
  $hit = Get-ChildItem $p -ErrorAction SilentlyContinue | Where-Object {
    $pr = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    ($_.PSChildName -eq 'GachaSimulate') -or ($pr -and $pr.PSObject.Properties['DisplayName'] -and $pr.DisplayName -eq 'GachaSimulate')
  }
  if ($hit) { throw 'Existing HKCU GachaSimulate install detected; refusing to overwrite.' }
}
`);
}

function postWmCloseToWindow(pid) {
  runPwsh(`
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinCloseHelper {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  public static IntPtr Find(uint targetPid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == targetPid && IsWindowVisible(h)) {
        var sb = new StringBuilder(256); GetWindowText(h, sb, sb.Capacity);
        if (sb.ToString() == title) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$h = [WinCloseHelper]::Find(${pid}, 'GachaSimulate')
if ($h -eq [IntPtr]::Zero) { throw 'Main window handle not found for WM_CLOSE' }
if (-not [WinCloseHelper]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'PostMessage WM_CLOSE failed' }
`);
}

function assertNoStrayInstalledWorker(workerExe) {
  const escaped = workerExe.replace(/'/g, "''");
  runPwsh(`
$expected = [System.IO.Path]::GetFullPath('${escaped}')
$w = @(Get-Process -Name 'gachasimulate-worker' -ErrorAction SilentlyContinue | Where-Object {
  try { [System.IO.Path]::GetFullPath($_.Path) -eq $expected } catch { $false }
})
if ($w.Count -gt 0) { throw "Stray installed worker process remained: $($w.Count)" }
exit 0
`);
}

async function waitForCdp(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Wait for WebView2 remote debugging listener to come up.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for WebView2 CDP on port ${port}`);
}

async function launchInstalledApp({ appExe, dataDir, workerExe }) {
  const port = await findFreePort();
  const isolatedPath = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  const child = spawn(appExe, [], {
    env: {
      ...process.env,
      Path: isolatedPath,
      PATH: isolatedPath,
      GACHASIMULATE_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  await waitForCdp(port);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const deadline = Date.now() + 15_000;
  let page = null;
  while (Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const candidate of ctx.pages()) {
        if (candidate.url().includes("tauri.localhost")) {
          page = candidate;
          break;
        }
      }
      if (page) break;
    }
    if (page) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(page, "Installed Tauri WebView2 page did not open");

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  // Reload once after listeners are attached so startup CSP/JS errors are also captured.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#root > *", { timeout: 15_000 });

  async function closeGracefully() {
    await browser.close();
    postWmCloseToWindow(child.pid);
    const result = await Promise.race([
      exited,
      new Promise((_, rej) =>
        setTimeout(
          () => rej(new Error("Timed out waiting for WM_CLOSE exit")),
          10_000,
        ),
      ),
    ]);
    assert.equal(
      result.code,
      0,
      `Expected exit code 0, got ${JSON.stringify(result)}`,
    );
    assertNoStrayInstalledWorker(workerExe);
  }

  return { child, browser, page, consoleErrors, pageErrors, closeGracefully };
}

async function writeSameIdLocalConfig(localRoot, id) {
  const dir = path.join(localRoot, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.yaml"),
    [
      `id: ${id}`,
      `name: 本地同名校验配置`,
      `description: 用于核对同 ID 官方与本地共存、切换统计物品与大整数精确读数`,
      `terminations:`,
      `  - file: fast.yaml`,
      `    name: 快速确定性校验`,
      `  - file: slow.yaml`,
      `    name: 长任务取消校验`,
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "config.yaml"),
    [
      `schema_version: 2`,
      `items:`,
      `  - item_a: 物品A`,
      `  - item_b: 物品B`,
      `pools:`,
      `  - main:`,
      `      - probability: 1`,
      `        actions:`,
      `          - item_a += 777`,
      `          - item_b += 3002399751580331`,
      `initial:`,
      `  - item_a = 0`,
      `  - item_b = 0`,
      `every_draw: []`,
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "fast.yaml"),
    [
      `retained_items: []`,
      `termination_rule:`,
      `  condition:`,
      `    check: item_a >= 777`,
      `    actions: terminate done`,
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "slow.yaml"),
    [
      `retained_items: []`,
      `termination_rule:`,
      `  condition:`,
      `    check: item_a >= 155400`,
      `    actions: terminate done`,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function main() {
  checkNoPreexistingInstall();
  const pkg = JSON.parse(
    await fs.readFile(path.join(projectRoot, "package.json"), "utf8"),
  );
  const installer = path.join(
    projectRoot,
    "target",
    "release",
    "bundle",
    "nsis",
    `GachaSimulate_${pkg.version}_x64-setup.exe`,
  );
  await fs.access(installer);

  const installRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "gachasimulate-m2-ui-install-"),
  );
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "gachasimulate-m2-ui-data-"),
  );
  const localConfigsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "gachasimulate-m2-ui-local-"),
  );
  const appExe = path.join(installRoot, "GachaSimulate.exe");
  const workerExe = path.join(installRoot, "gachasimulate-worker.exe");
  const uninstallExe = path.join(installRoot, "uninstall.exe");

  try {
    // 1. Fresh silent NSIS install (unquoted /D= via env vars so special path chars are never expanded)
    runPwsh(
      `
$p = Start-Process -FilePath $env:GS_INSTALLER -ArgumentList ('/S /D=' + $env:GS_INSTALL_ROOT) -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "NSIS silent install failed with exit code $($p.ExitCode)" }
exit 0
`,
      { GS_INSTALLER: installer, GS_INSTALL_ROOT: installRoot },
    );
    await fs.access(appExe);
    await fs.access(workerExe);

    // 2. First launch: verify fonts, zero CSP errors, live HTTPS refresh + install, and root lock
    const first = await launchInstalledApp({ appExe, dataDir, workerExe });
    try {
      const fontsLoaded = await first.page.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].map((font) => ({
          family: font.family,
          weight: font.weight,
          status: font.status,
        }));
      });
      const loadedFamilies = new Set(
        fontsLoaded
          .filter((f) => f.status === "loaded")
          .map((f) => f.family.replace(/^["']|["']$/g, "")),
      );
      assert.ok(
        loadedFamilies.has("JetBrains Mono") &&
          loadedFamilies.has("SourceHanSansSC"),
        `Expected both JetBrains Mono and SourceHanSansSC fonts to load, got: ${JSON.stringify(fontsLoaded)}`,
      );

      // Verify Milestone 2 shell hides visualization/edit/export entries
      const navText = await first.page
        .locator("aside.renderer-sidebar")
        .innerText();
      assert.doesNotMatch(navText, /结果可视化|图表预览|导出素材/);

      // Navigate to Config Repository -> live HTTPS refresh -> install first official package
      await first.page.getByRole("button", { name: "配置仓库" }).click();
      await first.page
        .getByText("官方目录已刷新。")
        .waitFor({ timeout: 30_000 });
      const firstCard = first.page.locator(".repository-card").first();
      const officialId = (await firstCard.locator("code").innerText()).trim();
      assert.ok(officialId.length > 0, "Expected official config ID");
      await firstCard.getByRole("button", { name: "安装" }).click();
      await first.page
        .locator(`.repository-card[data-status="installed"]`)
        .first()
        .waitFor({ timeout: 30_000 });

      // Verify second instance targeting the same dataDir fails promptly with non-zero exit code
      const secondInstance = spawn(appExe, [], {
        env: { ...process.env, GACHASIMULATE_DATA_DIR: dataDir },
        stdio: "ignore",
      });
      const secondExit = await Promise.race([
        new Promise((resolve) =>
          secondInstance.once("exit", (code, signal) =>
            resolve({ code, signal }),
          ),
        ),
        new Promise((_, reject) =>
          setTimeout(() => {
            secondInstance.kill();
            reject(
              new Error(
                "Second instance targeting active data root stayed running instead of failing root lock",
              ),
            );
          }, 10_000),
        ),
      ]);
      assert.ok(
        typeof secondExit.code === "number" && secondExit.code !== 0,
        `Second instance must exit with non-zero code due to root lock, got ${JSON.stringify(secondExit)}`,
      );

      assert.deepEqual(
        first.consoleErrors,
        [],
        `Unexpected console errors: ${first.consoleErrors}`,
      );
      assert.deepEqual(
        first.pageErrors,
        [],
        `Unexpected page errors: ${first.pageErrors}`,
      );

      await first.closeGracefully();

      // 3. Configure distinguishable same-ID local config and restart installed app
      await writeSameIdLocalConfig(localConfigsRoot, officialId);
      await fs.writeFile(
        path.join(dataDir, "configs", "local-config.json"),
        JSON.stringify({ localDirectory: localConfigsRoot }),
        "utf8",
      );

      const second = await launchInstalledApp({ appExe, dataDir, workerExe });
      try {
        const configSelect = second.page
          .locator("select.field-control")
          .first();
        await configSelect.waitFor({ timeout: 10_000 });
        const optionValues = await configSelect
          .locator("option")
          .evaluateAll((opts) => opts.map((o) => o.value));
        assert.ok(
          optionValues.includes(`installed:${officialId}`),
          `Persisted official config missing after restart: ${optionValues}`,
        );
        assert.ok(
          optionValues.includes(`local:${officialId}`),
          `Same-ID local config missing after restart: ${optionValues}`,
        );

        const runsInput = second.page.locator('input[type="number"]').first();
        const startButton = second.page.getByRole("button", {
          name: "启动模拟",
        });
        const statusBadge = second.page.locator(".panel-status.status-badge");
        const resultsDir = path.join(dataDir, "results");

        const waitForNewCompletedResult = async (previousCount) => {
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            const entries = (
              await fs.readdir(resultsDir).catch(() => [])
            ).filter((name) => name.endsWith(".gsr"));
            const status = await statusBadge.getAttribute("data-status");
            if (entries.length > previousCount && status === "completed") {
              return entries.length;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          throw new Error("Timed out waiting for new completed GSR result");
        };

        // 3a. Run official installed config (20 runs)
        await configSelect.selectOption(`installed:${officialId}`);
        await runsInput.fill("20");
        await startButton.click();
        let gsrCount = await waitForNewCompletedResult(0);
        const officialSummaryBtn = second.page.getByRole("button", {
          name: "查看本次结果",
        });
        await officialSummaryBtn.click();
        await second.page
          .locator('[data-testid="summary-total-result"]')
          .waitFor({ timeout: 15_000 });
        const officialTotalText = (
          await second.page
            .locator('[data-testid="summary-total-result"]')
            .innerText()
        ).trim();
        assert.ok(
          officialTotalText.length > 0 && officialTotalText !== "15540",
        );

        // 3b. Run same-ID local config with item_a (20 runs -> 15540)
        await second.page.getByRole("button", { name: "运行模拟" }).click();
        await configSelect.selectOption(`local:${officialId}`);
        await second.page
          .locator('label.simulation-item:has(input[value="item_a"])')
          .click();
        await runsInput.fill("20");
        await startButton.click();
        gsrCount = await waitForNewCompletedResult(gsrCount);
        await officialSummaryBtn.click();
        await second.page
          .locator('[data-testid="summary-total-result"]')
          .waitFor({ timeout: 15_000 });
        assert.equal(
          (
            await second.page
              .locator('[data-testid="summary-total-result"]')
              .innerText()
          ).trim(),
          "15540",
        );

        // 3c. Switch result_item to item_b (3 runs -> 9007199254740993 exact!)
        await second.page.getByRole("button", { name: "运行模拟" }).click();
        await second.page
          .locator('label.simulation-item:has(input[value="item_b"])')
          .click();
        await runsInput.fill("3");
        await startButton.click();
        await waitForNewCompletedResult(gsrCount);
        await officialSummaryBtn.click();
        await second.page
          .locator('[data-testid="summary-total-result"]')
          .waitFor({ timeout: 15_000 });
        assert.equal(
          (
            await second.page
              .locator('[data-testid="summary-total-result"]')
              .innerText()
          ).trim(),
          "9007199254740993",
        );
        const itemText = await second.page
          .locator('[data-testid="summary-result-item"]')
          .innerText();
        assert.match(itemText, /物品B/);
        assert.match(itemText, /item_b/);

        // 3d. Cancel a large slow simulation mid-run -> verify 0 new/temp files in results dir
        await second.page.getByRole("button", { name: "运行模拟" }).click();
        const termSelect = second.page.locator("select.field-control").nth(1);
        await termSelect.selectOption("slow.yaml");
        await second.page
          .locator('label.simulation-item:has(input[value="item_a"])')
          .click();
        await runsInput.fill("50000000");

        const beforeCancelFiles = (await fs.readdir(resultsDir)).sort();
        await startButton.click();
        const cancelButton = second.page.getByRole("button", {
          name: "取消",
        });
        await second.page
          .locator('.panel-status.status-badge[data-status="running"]')
          .waitFor({ timeout: 15_000 });
        await cancelButton.click();
        await second.page
          .locator('.panel-status.status-badge[data-status="cancelled"]')
          .waitFor({ timeout: 15_000 });
        const afterCancelFiles = (await fs.readdir(resultsDir)).sort();
        assert.deepEqual(
          afterCancelFiles,
          beforeCancelFiles,
          `Cancelled simulation left unexpected files: before=${beforeCancelFiles}, after=${afterCancelFiles}`,
        );

        // Verify zero console/CSP errors throughout entire run
        assert.deepEqual(
          second.consoleErrors,
          [],
          `Unexpected console errors: ${second.consoleErrors}`,
        );
        assert.deepEqual(
          second.pageErrors,
          [],
          `Unexpected page errors: ${second.pageErrors}`,
        );

        const finalStatus = await statusBadge.getAttribute("data-status");
        assert.equal(finalStatus, "cancelled");
        await second.closeGracefully();
        console.log(
          JSON.stringify(
            {
              verdict: "PASS",
              installer: path.basename(installer),
              officialId,
              loadedFontFamilies: [...loadedFamilies].sort(),
              verifiedFlows: [
                "fresh_nsis_install",
                "bundled_fonts_loaded",
                "zero_csp_ipc_errors",
                "live_https_refresh_and_install",
                "second_instance_root_lock_conflict",
                "restart_persistence",
                "same_id_official_and_local_runs",
                "result_item_switch_to_9007199254740993",
                "mid_run_cancel_zero_residual_files",
                "wm_close_exit_0_zero_stray_workers",
              ],
            },
            null,
            2,
          ),
        );
      } catch (err) {
        try {
          await second.browser.close();
        } catch {
          // ignore
        }
        try {
          second.child.kill();
        } catch {
          // ignore
        }
        throw err;
      }
    } catch (err) {
      try {
        await first.browser.close();
      } catch {
        // ignore
      }
      try {
        first.child.kill();
      } catch {
        // ignore
      }
      throw err;
    }
  } finally {
    try {
      await fs.access(uninstallExe);
      execFileSync(uninstallExe, ["/S"], { stdio: "ignore" });
    } catch {
      // ignore if already uninstalled
    }
    await new Promise((r) => setTimeout(r, 300));
    await fs.rm(installRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs
      .rm(localConfigsRoot, { recursive: true, force: true })
      .catch(() => {});
  }
}

await main();
