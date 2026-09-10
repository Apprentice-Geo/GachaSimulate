import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { cpus, hostname, release, type } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";

const exec_file = promisify(execFile);
const project_root = process.cwd();
const output_root = resolve("tmp/electron-export-performance");

type Options = {
  quick: boolean;
  repetitions: number;
  warmups: number;
  background_target_ms: number;
  sample_interval_ms: number;
  run_timeout_ms: number;
  seed_runs: number;
};
type MeasurementRun = {
  scenario: string;
  kind: string;
  sequence: number;
  valid: boolean;
  invalid_reasons: string[];
  elapsed_ms: number;
  phase_ms: Record<string, number | undefined>;
  event_max_gap_ms: number | null;
  timer_delay_p95_ms: number | null;
  cancel_ack_ms: number | null;
  overlap_ratio: number;
  memory: {
    peak_increment_bytes: number | null;
    minimum_available_bytes: number | null;
  };
};
type MeasurementData = {
  runs: MeasurementRun[];
  logical_cpu_count: number;
  physical_memory_bytes: number;
  versions: Record<string, string>;
  calibration: {
    simulation_runs: number;
    analysis_runs: number;
    attempts: unknown[];
  };
};
type Metadata = {
  commit: string;
  os: string;
  hostname: string;
  cpu: string;
  ffmpeg: Awaited<ReturnType<typeof ffmpeg_evidence>>;
};

function options(args: string[]): Options {
  const quick = args.includes("--quick");
  const positive = (name: string, fallback: number) => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    const value = Number(args[index + 1]);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
    return value;
  };
  return {
    quick,
    repetitions: positive("--repetitions", quick ? 1 : 5),
    warmups: positive("--warmups", 1),
    background_target_ms: positive(
      "--background-target-ms",
      quick ? 25_000 : 30_000,
    ),
    sample_interval_ms: 500,
    run_timeout_ms: positive("--run-timeout-ms", 120_000),
    seed_runs: positive("--seed-runs", quick ? 10_000 : 1_000_000),
  };
}

function run(command: string, args: string[], environment = process.env) {
  return new Promise<void>((done, reject) => {
    const child = spawn(command, args, {
      cwd: project_root,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? done() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

async function hash(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function production_build() {
  if (process.env.GACHASIMULATE_EXPORT_FRAME_PROBE)
    throw new Error("GACHASIMULATE_EXPORT_FRAME_PROBE must be unset");
  const environment = { ...process.env };
  delete environment.GACHASIMULATE_EXPORT_FRAME_PROBE;
  const package_manager = process.env.npm_execpath;
  if (!package_manager)
    throw new Error("npm_execpath is unavailable; run this tool through pnpm");
  await run(process.execPath, [package_manager, "run", "build"], environment);
  for (const name of await readdir(resolve("out/renderer/assets"))) {
    if (
      name.endsWith(".js") &&
      (await readFile(resolve("out/renderer/assets", name), "utf8")).includes(
        "data-export-frame-probe",
      )
    )
      throw new Error(`production build contains frame probe: ${name}`);
  }
}

async function ffmpeg_evidence() {
  const root = resolve("build/ffmpeg/win32-x64");
  const ffmpeg = join(root, "bin/ffmpeg.exe");
  const ffprobe = join(root, "bin/ffprobe.exe");
  const evidence = join(root, "materials/binary-sha256.txt");
  await Promise.all([ffmpeg, ffprobe, evidence].map(access));
  const expected = new Map<string, string>();
  for (const line of (await readFile(evidence, "utf8")).trim().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) \*([^\\/]+)$/i.exec(line.trim());
    if (!match) throw new Error(`invalid FFmpeg hash evidence: ${line}`);
    expected.set(match[2].toLowerCase(), match[1].toLowerCase());
  }
  const hashes = { ffmpeg: await hash(ffmpeg), ffprobe: await hash(ffprobe) };
  if (
    hashes.ffmpeg !== expected.get("ffmpeg.exe") ||
    hashes.ffprobe !== expected.get("ffprobe.exe")
  )
    throw new Error("FFmpeg binaries do not match binary-sha256.txt");
  const { stdout } = await exec_file(ffmpeg, ["-version"], {
    windowsHide: true,
  });
  return { ffmpeg, ffprobe, hashes, version: stdout.split(/\r?\n/)[0] };
}

function stats(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.ceil((p / 100) * sorted.length) - 1];
  return { raw: values, median: pick(50), p95: pick(95), max: sorted.at(-1)! };
}

const ms = (value?: number | null) => (value == null ? "—" : value.toFixed(1));
const mib = (value?: number | null) =>
  value == null ? "—" : (value / 1024 / 1024).toFixed(1);

function report_markdown(
  data: MeasurementData,
  metadata: Metadata,
  config: Options,
) {
  const scenarios = ["idle", "simulation", "analysis"];
  const rows = scenarios.map((scenario) => {
    const runs = data.runs.filter(
      (run) =>
        run.kind === "measurement" && run.scenario === scenario && run.valid,
    );
    const total = stats(runs.map((run) => run.elapsed_ms));
    const phase = (name: string) =>
      stats(
        runs
          .map((run) => run.phase_ms[name])
          .filter((value): value is number => Number.isFinite(value)),
      );
    const finite = (values: Array<number | null>) =>
      values.filter((value): value is number => Number.isFinite(value));
    const gap = stats(finite(runs.map((run) => run.event_max_gap_ms)));
    const delay = stats(finite(runs.map((run) => run.timer_delay_p95_ms)));
    const peak = stats(
      finite(runs.map((run) => run.memory.peak_increment_bytes)),
    );
    const available = finite(
      runs.map((run) => run.memory.minimum_available_bytes),
    );
    return `| ${scenario} | ${runs.length}/${config.repetitions} | ${ms(total?.median)} / ${ms(total?.p95)} / ${ms(total?.max)} | ${ms(phase("preparing")?.median)} / ${ms(phase("rendering")?.median)} / ${ms(phase("finalizing")?.median)} | ${ms(gap?.max)} | ${ms(delay?.p95)} | ${mib(peak?.max)} | ${mib(available.length ? Math.min(...available) : null)} |`;
  });
  const raw_rows = scenarios.map((scenario) => {
    const runs = data.runs.filter(
      (run) => run.kind === "measurement" && run.scenario === scenario,
    );
    const values = (selector: (run: MeasurementRun) => number | undefined) =>
      runs
        .map(selector)
        .map((value) => ms(value))
        .join(", ");
    return `| ${scenario} | ${values((run) => run.elapsed_ms)} | ${values((run) => run.phase_ms.preparing)} | ${values((run) => run.phase_ms.rendering)} | ${values((run) => run.phase_ms.finalizing)} |`;
  });
  const cancellations = scenarios.map((scenario) => {
    const run = data.runs.find(
      (item) => item.kind === "cancellation" && item.scenario === scenario,
    );
    return `| ${scenario} | ${ms(run?.cancel_ack_ms)} | ${run?.valid ? "valid" : `invalid: ${(run?.invalid_reasons ?? []).join("; ")}`} |`;
  });
  const invalid = data.runs.filter((run) => !run.valid);
  const violations = data.runs.filter(
    (run) =>
      (run.event_max_gap_ms ?? 0) > 1_000 || (run.cancel_ack_ms ?? 0) > 1_000,
  );
  const overlap = data.runs
    .filter((run) => run.kind === "measurement" && run.scenario === "analysis")
    .map((run) => `${(run.overlap_ratio * 100).toFixed(1)}%`)
    .join(", ");
  return `# Electron 导出阶段 D 性能复验

> ${config.quick ? "本报告来自 `--quick` 冒烟，不可用于路线决策。" : "本报告记录阶段 D 完整性能矩阵；不包含低内存/OOM 稳定性验证。"}

## 环境

- Git commit: \`${metadata.commit}\`
- OS / host: ${metadata.os} / ${metadata.hostname}
- CPU: ${metadata.cpu}; ${data.logical_cpu_count} logical CPUs
- RAM: ${mib(data.physical_memory_bytes)} MiB
- Electron / Chromium / Node: ${data.versions.electron} / ${data.versions.chrome} / ${data.versions.node}
- FFmpeg: ${metadata.ffmpeg.version}
- FFmpeg / ffprobe SHA-256: \`${metadata.ffmpeg.hashes.ffmpeg}\` / \`${metadata.ffmpeg.hashes.ffprobe}\`

## 参数与校准

- warmup/scenario: ${config.warmups}; measured runs/scenario: ${config.repetitions}
- sample interval: ${config.sample_interval_ms} ms; background target: ${config.background_target_ms} ms
- simulation runs: ${data.calibration.simulation_runs}; analysis GSR runs: ${data.calibration.analysis_runs}
- analysis overlap ratios: ${overlap || "—"}
- calibration attempts: \`${JSON.stringify(data.calibration.attempts)}\`

## 有效运行汇总

时间为 ms，内存为 MiB；阶段依次为 preparing/rendering/finalizing 中位数。五次原始值的 nearest-rank P95 等于最大值。

| scenario | valid | total median / P95 / max | phases median | event max gap | timer P95 | peak WS increment | min available |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join("\n")}

## 五次原始耗时

按实际轮换执行顺序列出每个场景的正式 run，单位为 ms；无效 run 仍保留在此处，并由异常章节说明。

| scenario | total | preparing | rendering | finalizing |
| --- | --- | --- | --- | --- |
${raw_rows.join("\n")}

## 取消确认

| scenario | cancelling received (ms) | validity |
| --- | ---: | --- |
${cancellations.join("\n")}

## 异常与契约

- Invalid runs: ${invalid.length}${invalid.length ? ` — ${invalid.map((run) => `${run.sequence}:${run.invalid_reasons.join(", ")}`).join("; ")}` : ""}
- 活性契约违约（事件间隔或取消确认 > 1000 ms）: ${violations.length}${violations.length ? ` — ${violations.map((run) => run.sequence).join(", ")}` : ""}
- 崩溃、超时、产物失败、采样不完整和资源残留均记录为 invalid，不进入聚合。

## 解释限制与维护者决定

Phase 0 使用逐帧探针 build、旧实验宿主和不同 FFmpeg；只能作为背景参考，不能严格计算回归比例。阶段 D 不设置新数值门槛，也没有执行低内存/OOM 稳定性测试。

维护者最终选择：**待评审（继续 / 要求优化 / 更换路线）**。
`;
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("measurement requires Windows x64");
  const config = options(process.argv.slice(2));
  await mkdir(output_root, { recursive: true });
  await production_build();
  const ffmpeg = await ffmpeg_evidence();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output_dir = join(
    output_root,
    `${config.quick ? "quick" : "full"}-${stamp}`,
  );
  const harness_dir = await mkdtemp(join(output_root, "harness-"));
  await mkdir(output_dir, { recursive: true });
  await writeFile(
    join(harness_dir, "package.json"),
    JSON.stringify({ private: true, main: "main.cjs" }),
  );
  await writeFile(
    join(harness_dir, "main.cjs"),
    `const {createRequire}=require("node:module");const r=createRequire(${JSON.stringify(resolve("package.json"))});r("tsx/cjs");r(${JSON.stringify(resolve("src/dev/electron_export_performance_harness.ts"))});`,
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.GACHASIMULATE_EXPORT_FRAME_PROBE;
  environment.GACHASIMULATE_EXPORT_PERFORMANCE_INPUT = JSON.stringify({
    ...config,
    project_root,
    output_dir,
    export_html: resolve("out/renderer/export.html"),
    export_preload: resolve("out/preload/export.js"),
    desktop_html: resolve("out/renderer/index.html"),
    desktop_preload: resolve("out/preload/index.js"),
    ffmpeg: ffmpeg.ffmpeg,
    ffprobe: ffmpeg.ffprobe,
  });
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: [harness_dir],
      cwd: project_root,
      env: environment,
    });
    application.process().stdout?.pipe(process.stdout);
    application.process().stderr?.pipe(process.stderr);
    let data: MeasurementData;
    try {
      data = (await application.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __electronExportPerformancePromise?: Promise<unknown>;
            }
          ).__electronExportPerformancePromise,
      )) as MeasurementData;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      await writeFile(
        join(output_dir, "runner-failure.json"),
        `${JSON.stringify({ at: new Date().toISOString(), message }, null, 2)}\n`,
      );
      await writeFile(
        join(output_dir, "REPORT.md"),
        `# Electron 导出阶段 D 性能复验\n\n测量未完成：${message}\n\n已完成的逐 run JSON 与失败详情保留在本目录；本次结果不得用于聚合或路线决策。\n`,
      );
      throw reason;
    }
    const { stdout } = await exec_file("git", ["rev-parse", "HEAD"], {
      cwd: project_root,
    });
    const metadata = {
      commit: stdout.trim(),
      os: `${type()} ${release()}`,
      hostname: hostname(),
      cpu: cpus()[0]?.model ?? "unknown",
      ffmpeg,
    };
    await writeFile(
      join(output_dir, "environment.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await writeFile(
      join(output_dir, "summary.json"),
      `${JSON.stringify(data, null, 2)}\n`,
    );
    await writeFile(
      join(output_dir, "REPORT.md"),
      report_markdown(data, metadata, config),
    );
    console.log(
      `Electron export performance report: ${join(output_dir, "REPORT.md")}`,
    );
  } finally {
    await application?.close().catch(() => undefined);
    await rm(harness_dir, { recursive: true, force: true });
  }
}

main().catch((reason: unknown) => {
  console.error(reason instanceof Error ? reason.stack : String(reason));
  process.exitCode = 1;
});
