import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { _electron as electron } from "playwright";
import { build, createServer } from "vite";
import { resolveConfig } from "electron-vite";
import { create_renderer_config } from "../../electron.vite.renderer.config";
import { result_fixture } from "./ui_fixtures";
import { build_cdf_view_model } from "../visualize/view/cdf_view_model";

const PROJECT_ROOT = process.cwd();

test("development server export renderer initializes and requests its first frame", async () => {
  const renderer_config = create_renderer_config();
  const server = await createServer({
    ...renderer_config,
    appType: "mpa",
    logLevel: "silent",
    server: {
      fs: { allow: [PROJECT_ROOT] },
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
    },
  });
  const preload_directory = await mkdtemp(
    path.join(tmpdir(), "gachasimulate-smoke-preload-"),
  );
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const previous_node_env = process.env.NODE_ENV;
    try {
      const { config } = await resolveConfig({ logLevel: "silent" }, "build");
      assert.ok(config?.preload);
      await build({
        ...config.preload,
        configFile: false,
        logLevel: "silent",
        build: { ...config.preload.build, outDir: preload_directory },
      });
    } finally {
      // electron-vite resolves a production build; the server stays in development.
      if (previous_node_env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous_node_env;
    }
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === "object");
    const export_url = `http://127.0.0.1:${address.port}/export.html`;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    env.GACHASIMULATE_SMOKE_PRELOAD = path.join(preload_directory, "export.js");
    application = await electron.launch({
      args: [
        path.join(
          PROJECT_ROOT,
          "src/dev/export_renderer_dev_smoke_harness.cjs",
        ),
        export_url,
      ],
      cwd: PROJECT_ROOT,
      env,
    });
    const page = await application.firstWindow();
    const page_errors: string[] = [];
    const resource_failures: string[] = [];
    page.on("pageerror", (error) => page_errors.push(error.message));
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      if (
        url.origin === new URL(export_url).origin &&
        ["document", "font", "script", "stylesheet"].includes(
          request.resourceType(),
        )
      ) {
        resource_failures.push(
          `${request.resourceType()} ${request.url()}: ${request.failure()?.errorText ?? "unknown failure"}`,
        );
      }
    });
    page.on("response", (response) => {
      const request = response.request();
      const url = new URL(response.url());
      if (
        url.origin === new URL(export_url).origin &&
        response.status() >= 400 &&
        ["document", "font", "script", "stylesheet"].includes(
          request.resourceType(),
        )
      ) {
        resource_failures.push(
          `${request.resourceType()} ${response.url()}: HTTP ${response.status()}`,
        );
      }
    });
    await page.waitForLoadState("domcontentloaded");
    const fixture = result_fixture();
    await application.evaluate(
      ({ BrowserWindow }, view_model) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send(
          "export-renderer:initialize",
          { job_id: "dev-smoke", view_model },
        );
      },
      build_cdf_view_model(fixture.analysis, fixture.display),
    );
    await assert.doesNotReject(() =>
      application!.evaluate(async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const messages = (
            globalThis as typeof globalThis & {
              exportRendererSmoke?: { messages: unknown[] };
            }
          ).exportRendererSmoke?.messages;
          if (messages?.length === 2) return;
          if (
            messages?.some((value) =>
              JSON.stringify(value).includes("renderer-failed"),
            )
          )
            throw new Error(JSON.stringify(messages));
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("export renderer development handshake timed out");
      }),
    );
    assert.deepEqual(
      await application.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              exportRendererSmoke: { messages: unknown[] };
            }
          ).exportRendererSmoke.messages,
      ),
      [
        { channel: "initialized", message: { job_id: "dev-smoke" } },
        {
          channel: "frame-ready",
          message: { job_id: "dev-smoke", frame: 0 },
        },
      ],
    );
    assert.deepEqual(page_errors, []);
    assert.deepEqual(resource_failures, []);
    assert.deepEqual(
      await application.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              exportRendererSmoke: { loadFailures: unknown[] };
            }
          ).exportRendererSmoke.loadFailures,
      ),
      [],
    );
  } finally {
    try {
      await application?.close();
    } finally {
      await server.close();
      await rm(preload_directory, { recursive: true, force: true });
    }
  }
});
