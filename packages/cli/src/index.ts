#!/usr/bin/env node
import { compile_yaml } from "@gachasimulate/config-compiler";
import { constants, realpathSync } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const NATIVE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../build/native/bin",
);

function usage(): never {
  throw new Error(
    "usage: gachasimulate simulate --config-dir <dir> --termination <filename> (--total-runs <positive> | --target-total-draw <positive>) --output <file.gsr> [--seed <int64>] [--threads <positive>]\n" +
      "       gachasimulate analyze --input <file.gsr> --metric <draw|cost>",
  );
}

function options(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key?.startsWith("--") ||
      value == null ||
      value.startsWith("--") ||
      result.has(key)
    )
      usage();
    result.set(key, value);
  }
  return result;
}

function require_option(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value == null) usage();
  return value;
}

function positive(value: string, name: string, max?: bigint): string {
  if (!/^[1-9][0-9]*$/.test(value) || (max != null && BigInt(value) > max)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function seed(value: string): string {
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(value))
    throw new Error("seed must be an int64");
  const number = BigInt(value);
  if (number < -(1n << 63n) || number > (1n << 63n) - 1n)
    throw new Error("seed must be an int64");
  return value;
}

async function child(binary: string, args: string[]): Promise<number> {
  return new Promise((resolve_code, reject) => {
    const process_child = spawn(join(NATIVE_DIR, binary), args, {
      stdio: "inherit",
    });
    const forward = (signal: NodeJS.Signals) => process_child.kill(signal);
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    process_child.once("error", reject);
    process_child.once("close", (code, signal_name) => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      resolve_code(code ?? (signal_name === "SIGINT" ? 130 : 143));
    });
  });
}

async function simulate(args: string[]): Promise<number> {
  const values = options(args);
  const allowed = new Set([
    "--config-dir",
    "--termination",
    "--total-runs",
    "--target-total-draw",
    "--output",
    "--seed",
    "--threads",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))) usage();
  const runs = values.get("--total-runs");
  const draws = values.get("--target-total-draw");
  if ((runs == null) === (draws == null)) usage();
  const config_dir = await realpath(require_option(values, "--config-dir"));
  const termination_name = require_option(values, "--termination");
  if (
    isAbsolute(termination_name) ||
    basename(termination_name) !== termination_name
  ) {
    throw new Error("termination must be a filename inside config directory");
  }
  const termination_path = await realpath(join(config_dir, termination_name));
  if (relative(config_dir, termination_path).startsWith("..")) {
    throw new Error("termination must be inside config directory");
  }
  const output = resolve(require_option(values, "--output"));
  if (!output.endsWith(".gsr"))
    throw new Error("output must have a .gsr extension");
  try {
    await access(output, constants.F_OK);
    throw new Error(`output already exists: ${output}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const [config_text, termination_text] = await Promise.all([
    readFile(join(config_dir, "config.yaml"), "utf8"),
    readFile(termination_path, "utf8"),
  ]);
  let manifest_text: string | undefined;
  try {
    manifest_text = await readFile(join(config_dir, "manifest.yaml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const program = compile_yaml(config_text, termination_text, manifest_text);
  const temporary = await mkdtemp(join(tmpdir(), "gachasimulate-"));
  try {
    const ir = join(temporary, "program.json");
    await writeFile(ir, JSON.stringify(program.ir));
    return await child("gachasimulate-core", [
      "--ir",
      ir,
      ...(runs == null
        ? ["--target-total-draw", positive(draws!, "target-total-draw")]
        : ["--total-runs", positive(runs, "total-runs", 500_000_000n)]),
      "--seed",
      seed(values.get("--seed") ?? "0"),
      "--threads",
      positive(values.get("--threads") ?? "1", "threads", 4_294_967_295n),
      "--output",
      output,
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function analyze(args: string[]): Promise<number> {
  const values = options(args);
  if ([...values.keys()].some((key) => !["--input", "--metric"].includes(key)))
    usage();
  const input = resolve(require_option(values, "--input"));
  const metric = require_option(values, "--metric");
  if (!isAbsolute(input) || !["draw", "cost"].includes(metric)) usage();
  return child("gachasimulate-analyze", ["--input", input, "--metric", metric]);
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const [command, ...rest] = args;
    if (command === "simulate") return await simulate(rest);
    if (command === "analyze") return await analyze(rest);
    usage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
