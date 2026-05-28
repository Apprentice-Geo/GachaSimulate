import react from "@vitejs/plugin-react";
import { promises as fs, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const PROJECT_ROOT = realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const INPUT_ENDPOINT = "/__visualize_input";

function is_path_inside(child_path: string, parent_path: string): boolean {
  const relative_path = path.relative(parent_path, child_path);
  return (
    relative_path === "" ||
    (!relative_path.startsWith("..") && !path.isAbsolute(relative_path))
  );
}

function send_json_response(
  response: ServerResponse,
  status_code: number,
  body: unknown,
): void {
  response.statusCode = status_code;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function handle_visualize_input_request(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): Promise<void> {
  const request_url = new URL(request.url ?? "/", "http://localhost");
  if (request_url.pathname !== INPUT_ENDPOINT) {
    next();
    return;
  }

  const requested_path = request_url.searchParams.get("path");
  if (!requested_path) {
    send_json_response(response, 400, { error: "缺少 input 路径。" });
    return;
  }

  const normalized_relative_path = requested_path.replaceAll("\\", "/");
  if (path.isAbsolute(normalized_relative_path)) {
    send_json_response(response, 400, {
      error: "input 只接受项目内相对路径。",
    });
    return;
  }

  const resolved_path = path.resolve(PROJECT_ROOT, normalized_relative_path);
  if (!is_path_inside(resolved_path, PROJECT_ROOT)) {
    send_json_response(response, 400, {
      error: "input 路径不能超出项目目录。",
    });
    return;
  }

  if (path.extname(resolved_path).toLowerCase() !== ".json") {
    send_json_response(response, 400, { error: "input 只支持 JSON 文件。" });
    return;
  }

  try {
    const content = await fs.readFile(resolved_path, "utf8");
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send_json_response(response, 404, {
      error: `无法读取 input 文件：${message}`,
    });
  }
}

function visualize_input_plugin(): Plugin {
  return {
    name: "visualize-input-loader",
    configureServer(server) {
      server.middlewares.use(handle_visualize_input_request);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle_visualize_input_request);
    },
  };
}

export default defineConfig({
  root: PROJECT_ROOT,
  plugins: [react(), visualize_input_plugin()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
