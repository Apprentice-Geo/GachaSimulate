import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ElectronApplication, Page } from "playwright";
import { build_cdf_view_model } from "../visualize/view/cdf_view_model";
import { result_fixture } from "./ui_fixtures";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../renderer/components/Button";
import { Field } from "../renderer/components/Field";

async function assert_workbench_primitives(page: Page) {
  const markup = renderToStaticMarkup(
    createElement(
      "div",
      null,
      ...(["primary", "secondary", "ghost", "danger"] as const).map((variant) =>
        createElement(Button, { variant, key: variant }, variant),
      ),
      createElement(Button, { disabled: true }, "disabled"),
      createElement(
        Field,
        null,
        "Primitive field",
        createElement("input", { className: "field-control" }),
      ),
    ),
  );
  const result = await page.evaluate(
    ({ markup }) => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:0;top:0;z-index:2000";
      probe.innerHTML = markup;
      document.querySelector(".renderer-shell")!.append(probe);
      try {
        const styles = {
          read() {
            return [...probe.querySelectorAll("button")].map((button) => {
              const style = getComputedStyle(button);
              return [
                style.backgroundColor,
                style.color,
                style.borderColor,
                style.padding,
                style.minHeight,
                style.opacity,
                style.cursor,
              ];
            });
          },
        };
        const before = styles.read();
        // Neither page ancestry nor sibling position determines a variant.
        probe.className = "simulation-actions repository-card-actions";
        const buttons = [...probe.querySelectorAll("button")];
        buttons
          .reverse()
          .forEach((button) => button.parentElement!.append(button));
        const after = styles.read().reverse();
        const input = probe.querySelector("input")!;
        const label = probe.querySelector("label")!;
        return {
          before,
          after,
          label_associated: input.labels?.[0] === label,
          button_types: buttons.map((button) => button.type),
        };
      } finally {
        probe.remove();
      }
    },
    { markup },
  );
  assert.deepEqual(
    result.after,
    result.before,
    "Button appearance must not depend on its page or position",
  );
  assert.equal(
    new Set(result.before.slice(0, 4).map((style) => JSON.stringify(style)))
      .size,
    4,
  );
  assert.equal(result.before[4][5], "1", "Disabled text retains full opacity");
  assert.notEqual(result.before[4][0], result.before[0][0]);
  assert.notEqual(result.before[4][1], result.before[0][1]);
  assert.equal(result.before[4][6], "not-allowed");
  assert.ok(result.label_associated);
  assert.deepEqual(result.button_types, Array(5).fill("button"));
}

/** Compare design-space paint and typography, independently of host scaling. */
export async function chart_style(page: Page) {
  return page.locator(".cdf-chart-shell").evaluate((chart) => {
    const selectors = [
      ":scope",
      ".axis-title",
      ".recharts-cartesian-axis-tick-value",
      ".cdf-curve-path",
      ".marker-label",
      ".marker-line",
      ".marker-point",
    ];
    const properties = [
      "color",
      "background-color",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "letter-spacing",
      "fill",
      "stroke",
      "stroke-width",
      "stroke-dasharray",
      "filter",
    ];
    return selectors.map((selector) => {
      const nodes =
        selector === ":scope" ? [chart] : [...chart.querySelectorAll(selector)];
      if (!nodes.length) throw new Error(`Missing chart element: ${selector}`);
      return nodes.map((node) => {
        const style = getComputedStyle(node);
        return properties.map((property) => style.getPropertyValue(property));
      });
    });
  });
}

/** Workbench themes change paint, never chart presentation or desktop geometry. */
export async function assert_workbench_themes(page: Page) {
  const before = await chart_style(page);
  const read = () =>
    page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".workbench-host")!;
      const selectors = [
        ".renderer-sidebar",
        ".renderer-main",
        ".renderer-nav-button",
        ".cdf-chart-shell",
      ];
      return {
        background: getComputedStyle(host).backgroundColor,
        scheme: getComputedStyle(host).colorScheme,
        chart_scheme: getComputedStyle(
          document.querySelector(".visualize-scope")!,
        ).colorScheme,
        viewport_background: document.querySelector(".visualize-viewport")
          ? getComputedStyle(document.querySelector(".visualize-viewport")!)
              .backgroundColor
          : null,
        geometry: selectors.map((selector) => {
          const node = document.querySelector(selector)!;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return [
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            style.fontSize,
            style.lineHeight,
          ];
        }),
      };
    });
  const light = await read();
  assert.equal(light.scheme, "light");
  assert.equal(light.chart_scheme, "dark");
  await page.locator(".workbench-host").evaluate((node) => {
    (node as HTMLElement).dataset.workbenchTheme = "dark";
  });
  try {
    const dark = await read();
    assert.equal(dark.scheme, "dark");
    assert.equal(dark.chart_scheme, "dark");
    assert.notEqual(dark.background, light.background);
    assert.equal(dark.viewport_background, light.viewport_background);
    if (light.viewport_background) {
      assert.notEqual(
        light.viewport_background,
        "rgba(0, 0, 0, 0)",
        "Visualization backdrop is opaque and independent",
      );
    }
    assert.deepEqual(dark.geometry, light.geometry);
    assert.deepEqual(await chart_style(page), before);
    await assert_workbench_primitives(page);
  } finally {
    await page.locator(".workbench-host").evaluate((node) => {
      delete (node as HTMLElement).dataset.workbenchTheme;
    });
  }
  assert.deepEqual(await read(), light);
}

export async function assert_style_boundaries(page: Page) {
  const names = ["tokens", "scene", "preview"];
  const sources = await Promise.all(
    names.map((name) => readFile(`src/visualize/styles/${name}.css`, "utf8")),
  );
  const violations = await page.evaluate((sources) => {
    const failures: string[] = [];
    for (const source of sources) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(source);
      const rules = [...sheet.cssRules];
      for (const rule of rules) {
        if (rule instanceof CSSKeyframesRule) continue;
        if (rule instanceof CSSMediaRule) {
          rules.push(...rule.cssRules);
          continue;
        }
        if (
          !(rule instanceof CSSStyleRule) ||
          rule.selectorText
            .split(",")
            .some(
              (selector) =>
                !/^(?:\.visualize-scope|:where\(\.visualize-scope\))/.test(
                  selector.trim(),
                ),
            )
        )
          failures.push(rule.cssText);
      }
    }
    return failures;
  }, sources);
  assert.deepEqual(violations, [], "Visualization rules must be scoped");
  const workbench = await readFile("src/renderer/styles.css", "utf8");
  await assert_workbench_primitives(page);
  const tokens = await readFile("src/renderer/tokens.css", "utf8");
  const theme_keys = await page.evaluate((source) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(source);
    return [...sheet.cssRules]
      .slice(0, 2)
      .map((rule) =>
        [...(rule as CSSStyleRule).style]
          .filter((key) => key.startsWith("--workbench-"))
          .sort(),
      );
  }, tokens);
  assert.deepEqual(
    theme_keys[1],
    theme_keys[0],
    "Light and Dark define the same theme roles",
  );
  assert.doesNotMatch(
    workbench,
    /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i,
    "Workbench colors belong in tokens",
  );
  assert.doesNotMatch(
    workbench + tokens,
    /var\(--(?:color-|font-|radius-|canvas-)/,
  );

  assert.equal(await page.locator(".chart-preview.visualize-scope").count(), 1);
  const before = await chart_style(page);
  const navigation_style = () =>
    page
      .locator(".renderer-nav-button")
      .first()
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.color, style.fontFamily, style.backgroundColor];
      });
  const navigation_before = await navigation_style();
  // Apply a visibly different Workbench theme. The embedded chart must not inherit it.
  await page.locator(".workbench-host").evaluate((node) => {
    (node as HTMLElement).style.setProperty("--workbench-font-ui", "serif");
    (node as HTMLElement).style.setProperty(
      "--workbench-text-muted",
      "rgb(255, 0, 0)",
    );
    (node as HTMLElement).style.setProperty(
      "--workbench-surface",
      "rgb(0, 255, 0)",
    );
  });
  try {
    assert.notDeepEqual(await navigation_style(), navigation_before);
    assert.deepEqual(await chart_style(page), before);
  } finally {
    await page.locator(".workbench-host").evaluate((node) => {
      for (const token of ["font-ui", "text-muted", "surface"])
        (node as HTMLElement).style.removeProperty(`--workbench-${token}`);
    });
  }
  await page.locator(".chart-preview").evaluate((node) => {
    (node as HTMLElement).style.setProperty(
      "--color-text-muted",
      "rgb(255, 0, 0)",
    );
    (node as HTMLElement).style.setProperty("--font-mono", "serif");
  });
  try {
    assert.notDeepEqual(await chart_style(page), before);
    assert.deepEqual(await navigation_style(), navigation_before);
  } finally {
    await page.locator(".chart-preview").evaluate((node) => {
      (node as HTMLElement).style.removeProperty("--color-text-muted");
      (node as HTMLElement).style.removeProperty("--font-mono");
    });
  }
  // A class collision inside the island must not acquire Workbench panel borders.
  const border = await page.locator(".chart-preview").evaluate((node) => {
    const probe = document.createElement("div");
    probe.className = "panel-heading";
    node.append(probe);
    const border = getComputedStyle(probe).borderBottomWidth;
    probe.remove();
    return border;
  });
  assert.equal(border, "0px");
  await assert_workbench_themes(page);
  return before;
}

export async function assert_export_style(
  application: ElectronApplication,
  expected: Awaited<ReturnType<typeof chart_style>>,
) {
  const fixture = result_fixture();
  const view_model = build_cdf_view_model(fixture.analysis!, fixture.display!);
  const [page, window_id] = await Promise.all([
    application.waitForEvent("window"),
    application.evaluate(
      async ({ BrowserWindow }, input) => {
        const window = new BrowserWindow({
          show: false,
          width: 3840,
          height: 2160,
          useContentSize: true,
          webPreferences: {
            preload: input.preload,
            offscreen: true,
            backgroundThrottling: false,
          },
        });
        await window.loadFile(input.html);
        window.webContents.send("export-renderer:initialize", {
          job_id: "style-contract",
          view_model: input.view_model,
        });
        return window.id;
      },
      {
        preload: path.resolve("out/preload/export.js"),
        html: path.resolve("out/renderer/export.html"),
        view_model,
      },
    ),
  ]);
  try {
    await page.waitForURL("**/export.html");
    await page.locator(".cdf-chart-shell").waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator("body.visualize-scope > #root").count(), 1);
    assert.deepEqual(await chart_style(page), expected);
    assert.deepEqual(
      await page.evaluate(() => [
        document.body.clientWidth,
        document.body.clientHeight,
        document.body.scrollWidth,
        document.body.scrollHeight,
        document.documentElement.scrollWidth,
        document.documentElement.scrollHeight,
      ]),
      [3840, 2160, 3840, 2160, 3840, 2160],
    );
  } finally {
    await application.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(),
      window_id,
    );
  }
}
