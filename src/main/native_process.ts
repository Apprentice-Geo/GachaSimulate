import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";

export const NATIVE_PROCESS_TIMEOUT_MS = 10_000;

function readable_error(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export function resolve_native_executable(
  name: string,
  override?: string,
): string {
  const directory = resolve(
    override ??
      (process.env.ELECTRON_RENDERER_URL || !process.resourcesPath
        ? join(process.cwd(), "build", "native", "bin")
        : join(process.resourcesPath, "native", "bin")),
  );
  return join(
    directory,
    `${name}${process.platform === "win32" ? ".exe" : ""}`,
  );
}

export async function terminate_native_process(
  child: ChildProcess,
): Promise<void> {
  if (process.platform !== "win32") {
    try {
      if (!child.kill("SIGTERM")) throw new Error("process was not running");
      return;
    } catch (error) {
      throw new Error(
        `failed to terminate native process: ${readable_error(error).message}`,
        { cause: error },
      );
    }
  }
  if (!child.pid)
    throw new Error("failed to terminate native process: process has no PID");
  await new Promise<void>((resolve, reject) => {
    execFile(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { timeout: NATIVE_PROCESS_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        const detail = stderr.trim();
        if (error) {
          reject(
            new Error(
              `failed to terminate native process: ${detail || error.message}`,
            ),
          );
        } else {
          resolve();
        }
      },
    );
  });
}

export async function wait_for_process_close<T>(
  close: Promise<T>,
  timeout_ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      close,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout_ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
