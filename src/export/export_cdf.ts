import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { validate_analysis } from "../visualize/data/analysis";
import { validate_display_config } from "../visualize/data/validate_display_config";
import { CDF_COMPOSITION_ID } from "../visualize/remotion/constants";
import { build_cdf_view_model } from "../visualize/view/cdf_view_model";
import {
  DEFAULT_OUTPUT_DIR,
  ensure_output_dir,
  PROJECT_ROOT,
  remove_existing_final_outputs,
  resolve_project_relative_path,
} from "./paths";

interface CliArgs {
  gsr: string | null;
  display: string | null;
}

function parse_args(argv: string[]): CliArgs {
  const gsr_index = argv.indexOf("--gsr");
  const display_index = argv.indexOf("--display");
  return {
    gsr: gsr_index >= 0 && argv[gsr_index + 1] ? argv[gsr_index + 1] : null,
    display:
      display_index >= 0 && argv[display_index + 1]
        ? argv[display_index + 1]
        : null,
  };
}

async function load_cdf_view_model(gsr_path: string, display_path: string) {
  const gsr = resolve_project_relative_path(gsr_path);
  const display = resolve_project_relative_path(display_path);
  const analyze = promisify(execFile);
  const command = path.join(
    PROJECT_ROOT,
    "build/native/bin",
    `gachasimulate-analyze${process.platform === "win32" ? ".exe" : ""}`,
  );
  const { stdout } = await analyze(command, ["--input", gsr], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const analysis = validate_analysis(JSON.parse(stdout));
  const display_config = validate_display_config(
    JSON.parse(await fs.readFile(display, "utf8")),
  );
  return build_cdf_view_model(analysis, display_config);
}

async function export_cdf(gsr_path: string, display_path: string) {
  const data = await load_cdf_view_model(gsr_path, display_path);
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
  if (!args.gsr || !args.display) {
    throw new Error(
      "缺少 --gsr 或 --display 参数。用法：pnpm run export:cdf -- --gsr <file.gsr> --display <file.visualize.json>",
    );
  }

  await export_cdf(args.gsr, args.display);
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
