import { spawn } from "node:child_process";
import path from "node:path";
import { createServer } from "vite";

const PROJECT_ROOT = process.cwd();
const TEST_PORT = 5173;

function run_playwright(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(PROJECT_ROOT, "node_modules/@playwright/test/cli.js"),
        "test",
        ...args,
      ],
      {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
      },
    );

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const server = await createServer({
    configFile: path.join(PROJECT_ROOT, "vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: TEST_PORT,
      strictPort: true,
    },
  });

  await server.listen();
  try {
    const exit_code = await run_playwright(process.argv.slice(2));
    process.exitCode = exit_code;
  } finally {
    await server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
