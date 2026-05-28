import { promises as fs } from "node:fs";
import path from "node:path";

export const PROJECT_ROOT = process.cwd();
export const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, "outputs");

function is_path_inside(child_path: string, parent_path: string): boolean {
  const relative_path = path.relative(parent_path, child_path);
  return (
    relative_path === "" ||
    (!relative_path.startsWith("..") && !path.isAbsolute(relative_path))
  );
}

export function resolve_project_relative_path(relative_path: string): string {
  const normalized_path = relative_path.replaceAll("\\", path.sep);
  if (path.isAbsolute(normalized_path)) {
    throw new Error("--input 必须是项目内相对路径。");
  }

  const resolved_path = path.resolve(PROJECT_ROOT, normalized_path);
  if (!is_path_inside(resolved_path, PROJECT_ROOT)) {
    throw new Error("--input 不能指向项目目录外。");
  }

  return resolved_path;
}

export async function ensure_output_dir(output_dir = DEFAULT_OUTPUT_DIR) {
  await fs.mkdir(output_dir, { recursive: true });
}

export async function remove_existing_final_outputs(
  output_dir = DEFAULT_OUTPUT_DIR,
) {
  await Promise.all(
    ["cdf-result.png", "cdf-animation.webm", "cdf-animation.mp4"].map(
      (file_name) => fs.rm(path.join(output_dir, file_name), { force: true }),
    ),
  );
}
