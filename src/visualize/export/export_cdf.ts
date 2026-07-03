import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { promises as fs } from "node:fs";
import path from "node:path";
import { load_input_from_value } from "../data/load_input";
import { build_visualize_view_model } from "../view/cdf_view_model";
import { CDF_COMPOSITION_ID } from "../remotion/constants";
import {
  DEFAULT_OUTPUT_DIR,
  ensure_output_dir,
  PROJECT_ROOT,
  remove_existing_final_outputs,
  resolve_project_relative_path,
} from "./paths";

interface CliArgs {
  input: string | null;
}

function parse_args(argv: string[]): CliArgs {
  const input_index = argv.indexOf("--input");
  return {
    input:
      input_index >= 0 && argv[input_index + 1] ? argv[input_index + 1] : null,
  };
}

async function load_cdf_view_model(input_path: string) {
  const resolved_input_path = resolve_project_relative_path(input_path);
  const input_text = await fs.readFile(resolved_input_path, "utf8");
  const input_json = JSON.parse(input_text) as unknown;
  const normalized_input = await load_input_from_value(input_json);
  return build_visualize_view_model(normalized_input);
}

async function export_cdf(input_path: string) {
  const data = await load_cdf_view_model(input_path);
  const output_dir = DEFAULT_OUTPUT_DIR;
  const png_path = path.join(output_dir, "cdf-result.png");
  const mp4_path = path.join(output_dir, "cdf-animation.mp4");
  const entry_point = path.join(
    PROJECT_ROOT,
    "src/visualize/remotion/index.ts",
  );

  await ensure_output_dir(output_dir);
  await remove_existing_final_outputs(output_dir);

  const serve_url = await bundle({
    entryPoint: entry_point,
    publicDir: path.join(PROJECT_ROOT, "fonts"),
  });
  const input_props = { data };
  const composition = await selectComposition({
    serveUrl: serve_url,
    id: CDF_COMPOSITION_ID,
    inputProps: input_props,
  });

  await renderMedia({
    serveUrl: serve_url,
    composition,
    codec: "h264",
    crf: 18,
    muted: true,
    outputLocation: mp4_path,
    inputProps: input_props,
    pixelFormat: "yuv420p",
  });
  await renderStill({
    serveUrl: serve_url,
    composition,
    output: png_path,
    inputProps: input_props,
    frame: composition.durationInFrames - 1,
    imageFormat: "png",
  });
}

async function main() {
  const args = parse_args(process.argv.slice(2));
  if (!args.input) {
    throw new Error(
      "缺少 --input 参数。用法：pnpm run export:cdf -- --input <json文件路径>",
    );
  }

  await export_cdf(args.input);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
