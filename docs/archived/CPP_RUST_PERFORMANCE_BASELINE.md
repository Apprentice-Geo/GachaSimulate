# C++ / Rust 模拟—统计链路性能基线

> 本报告于 2026-11-28 完成实测，记录 Windows x64 原生环境下旧 C++（GCC 16.2 Release，GSR v2）与新 Rust（rustc 1.99.1 Release，分块流式 GSR v3）两条链路的实测耗时、峰值工作集内存、GSR 体积与累计结果对照。

## 结论

- 在代表持续吞吐的 **`1,000,000 runs`** 规模下（程序编译就绪后开始计时，直至完整批量模拟并写完 GSR）：
  - **单线程**：Rust 较 C++ 快 **`3.35–3.94×`**（`baseline_probability` `528.95 ms` vs `2082.56 ms`；`condition_tree_rules` `524.66 ms` vs `2014.49 ms`；`weighted_pool` `1257.83 ms` vs `4215.99 ms`）。
  - **16 线程**：Rust 较 C++ 快 **`2.79–2.94×`**（`126.63–210.22 ms` vs `366.02–617.81 ms`）。
- 在 **`10,000 runs`** 规模下，Rust 单线程快 **`2.99–3.01×`**，16 线程快 **`1.45–1.86×`**。在 **`100 runs`** 规模下，核心耗时仅 `1.6–4.0 ms`，受线程创建、文件落盘与插桩差异主导（Rust `0.92–1.18×`）。
- **重新打开 GSR → 写出 Analysis JSON**（含子进程完整生命周期）：在 `1,000,000 runs` 下 Rust 进程总耗时为 `53.73–60.89 ms`（进程内核心统计与写盘为 `34.98–40.52 ms`），C++ 为 `56.81–69.36 ms`，C++ / Rust 进程耗时比为 **`1.00–1.20×`**。
- **峰值内存（Windows Working Set）**：在 `1,000,000 runs` 下，Rust 单线程模拟仅占 **`5.7 MiB`**（C++ 为 `17.4–17.5 MiB`），16 线程模拟占 `12.3–13.4 MiB`（C++ 为 `17.8 MiB`）；本组低基数配置下 Rust 分析进程稳定在 **`5.4 MiB`**（C++ 为 `13.7 MiB`）。分块流式 GSR v3 将模拟期结果缓冲与总 run 数解耦；分析阶段不保留原始 run 数组，但仍按不同期末库存值的基数维护频数表（受 64 MiB 紧凑 Analysis JSON 早停上限约束）。
- **GSR 文件体积**：`1,000,000 runs` 下 C++ v2 为 `12,000,128–12,000,143 B`，Rust v3 为 `12,001,108–12,001,111 B`（仅增加约 `0.008%` 的块头开销）。
- **结果一致性**：确定性配置 `condition_tree_rules` 两端 `total_result` 完全一致（`600` / `60,000` / `6,000,000`）；随机配置在百万 runs 下的 `total_result` 相对差异仅 `-0.10%`（`baseline_probability`）与 `+0.014%`（`weighted_pool`），符合两套独立随机流的统计波动范围。

## 测量环境与版本

| 项目 | 值 |
| --- | --- |
| 日期 | 2026-11-28 |
| OS | Microsoft Windows 11 专业版 `10.0.26300 (Build 26300)`（x64） |
| CPU | 13th Gen Intel Core i9-13900HX（24 cores / 32 logical CPUs） |
| 内存 | 63.7 GiB RAM |
| C++ 基线提交 | `7214d2da5331216941ff2256f6351f3b69faf26f`（`v0.3.2`，`cpp/` 源码在集成分支未改动） |
| Rust 测量提交 | `980761198147b3ba37952fa18e05c056ee0c03ee`（`refactor/tauri-rust-canvas`） |
| C++ 工具链 | `g++ (Rev6, Built by MSYS2 project) 16.2.0`，CMake `4.4.3`，Ninja `1.13.2`（Release） |
| Rust 工具链 | `rustc 1.99.1 (58cf8f9c3 2026-10-13)`，`cargo 1.99.1 (5f94df478 2026-08-27)`（`--release`） |
| `gachasimulate-core.exe` SHA-256 | `f0f32b3a9047e12b7bb57b3e496210a954d39ca172480e78cc4eb921760db065` |
| `gachasimulate-analyze.exe` SHA-256 | `658a316c246dae0ea85c7d8cc11e23f343349a8e1a752af827ec8ab95962d31d` |
| `gachasimulate-cli.exe` SHA-256 | `51b59956cd1807ce6422b3df24106ce7b7f528e03449d8e885ea5edf282e42ea` |

> 说明：本轮 1G 实测原计划由 Codex 执行；因 Codex 订阅额度在准备阶段耗尽，按 `subscription-orchestrator` 降级规则由 Gemini 4 Neon 在空载本机完成全部 180 组随机交错实测与报告整理。

## 实验边界与复测方法

- **配置与参数**：`benchmark/cases/baseline_probability`、`benchmark/cases/condition_tree_rules`、`benchmark/cases/weighted_pool`；统计物品 `draw_count`，种子 `123`，线程数 `1` 与 `16`。
- **重复与交错**：`100`、`10,000`、`1,000,000 runs` 分别独立重复 `7`、`5`、`3` 次，共 `180` 组试验，固定种子 `20261128` 随机打散执行顺序；测量前进行一次未计入统计的预热；测量期间无并行编译或编码负载。
- **计时边界（含插桩差异说明）**：
  - **模拟 → GSR（核心耗时）**：两端均在程序编译就绪后开始计时，到完整批量模拟并落盘完成 GSR 为止，但存在插桩边界差异：C++ 端使用 TS 编译器预先生成 IR，在父进程通过 `perf_counter` 记录 `gachasimulate-core.exe` 输出 `{"type":"stage","stage":"simulating"}`（`load_ir_file` 完成）至 `{"type":"completed"}`（`write_gsr_v2` 完成）的间隔（包含节流进度 JSON 输出与管道传递）；Rust 端读取 `gachasimulate-cli.exe simulate --timing` 在 `compile_snapshot` 完成后至临时 GSR 原子替换完成的进程内 `Instant::now()` 耗时（使用空进度回调，不含进程启动）。上述插桩差异在 `100 runs`（数毫秒）档位占比明显，在 `1,000,000 runs`（数百至数千毫秒）档位可忽略。
  - **GSR → Analysis JSON**：以子进程完整墙钟时间衡量“重新打开 GSR 至写完紧凑 Analysis JSON 文件”的端到端耗时（C++ 重定向 `gachasimulate-analyze.exe` 标准输出到文件；Rust 使用 `gachasimulate-cli.exe analyze --input ... --output ... --timing`），并同时记录 Rust 进程内分析+写盘耗时以剥离 Windows 进程启动开销。
- **峰值内存**：对每个子进程在退出后、关闭句柄前统一调用 Win32 `GetProcessMemoryInfo` 读取内核维护的 `PeakWorkingSetSize`（可准确捕获毫秒级短进程的峰值工作集）。

### 复测命令

`benchmark/cases/<case>` 仅包含 `config.yaml` 与 `termination.yaml`，不包含 `manifest.yaml`。复测时需先为每个 case 准备包含最小 `manifest.yaml` 的临时目录，并由 `@gachasimulate/config-compiler` 预编译 C++ 所需的 IR JSON：

```powershell
# 1. 构建 C++ Release 基线（旧实现退场后可从提交 7214d2d 检出复建）
pnpm run check:cpp:release
pnpm run build:packages

# 2. 构建 Rust Release 二进制
cargo build --release -p gachasimulate-cli

# 3. 准备单个 case 的临时配置目录（补齐 manifest.yaml）与 C++ IR JSON
$case = "baseline_probability"
$work = Join-Path ([IO.Path]::GetTempPath()) "gs-1g-repro"
$cfgDir = Join-Path $work $case
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
Copy-Item "benchmark\cases\$case\config.yaml", "benchmark\cases\$case\termination.yaml" -Destination $cfgDir
@"
id: $case
name: $case
description: benchmark case
terminations:
  - file: termination.yaml
    name: default
"@ | Set-Content (Join-Path $cfgDir "manifest.yaml") -Encoding utf8

$irPath = Join-Path $work "$case.ir.json"
node -e "
const fs = require('node:fs');
const path = require('node:path');
const { compile_yaml } = require('./packages/config-compiler/dist/index.js');
const dir = process.argv[1];
const out = compile_yaml(
  fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8'),
  fs.readFileSync(path.join(dir, 'termination.yaml'), 'utf8'),
  fs.readFileSync(path.join(dir, 'manifest.yaml'), 'utf8'),
  'draw_count'
);
fs.writeFileSync(process.argv[2], JSON.stringify(out.ir));
" $cfgDir $irPath

# 4. 运行 C++ 与 Rust Release 测量（示例：1,000,000 runs、16 线程）
$cppGsr = Join-Path $work "$case-cpp.gsr"
$rustGsr = Join-Path $work "$case-rust.gsr"
Remove-Item $cppGsr, $rustGsr -ErrorAction SilentlyContinue
build\native\bin\gachasimulate-core.exe --ir $irPath --total-runs 1000000 --seed 123 --threads 16 --output $cppGsr
build\native\bin\gachasimulate-analyze.exe --input $cppGsr > (Join-Path $work "$case-cpp.analysis.json")

target\release\gachasimulate-cli.exe simulate --config-dir $cfgDir --termination termination.yaml --result-item draw_count --runs 1000000 --seed 123 --threads 16 --output $rustGsr --timing
target\release\gachasimulate-cli.exe analyze --input $rustGsr --output (Join-Path $work "$case-rust.analysis.json") --timing
```

## 结果：100 runs（7 次独立重复）

### 模拟 → GSR

| 配置 | 线程 | C++ 中位数（范围）ms | Rust 中位数（范围）ms | C++ / Rust | C++ 内存 MiB | Rust 内存 MiB | C++ GSR B | Rust GSR B | C++ `total_result` | Rust `total_result` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline_probability` | 1 | 1.90 (1.64–2.10) | 1.61 (1.46–1.71) | 1.18× | 6.2 | 5.7 | 1,343 | 1,335 | 1,461 | 1,549 |
| `baseline_probability` | 16 | 3.53 (3.20–4.41) | 3.39 (2.90–4.26) | 1.04× | 6.2 | 5.8 | 1,343 | 1,719 | 1,461 | 1,549 |
| `condition_tree_rules` | 1 | 1.99 (1.46–2.57) | 1.70 (1.57–2.02) | 1.17× | 6.2 | 5.7 | 1,328 | 1,332 | 600 | 600 |
| `condition_tree_rules` | 16 | 3.74 (2.52–4.16) | 3.71 (3.15–4.27) | 1.01× | 6.2 | 5.8 | 1,328 | 1,716 | 600 | 600 |
| `weighted_pool` | 1 | 2.00 (1.48–2.36) | 1.79 (1.43–2.76) | 1.11× | 6.2 | 5.7 | 1,343 | 1,335 | 3,248 | 3,356 |
| `weighted_pool` | 16 | 3.65 (3.09–4.63) | 3.97 (3.05–5.79) | 0.92× | 6.2 | 5.8 | 1,343 | 1,719 | 3,248 | 3,356 |

### GSR → Analysis JSON

| 配置 | 来源线程 | C++ 进程中位数（范围）ms | Rust 进程中位数（范围）ms | Rust 进程内中位数 ms | C++ / Rust（进程） | C++ 内存 MiB | Rust 内存 MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline_probability` | 1 | 27.22 (19.98–30.85) | 19.20 (16.05–30.59) | 1.72 | 1.42× | 6.0 | 5.4 |
| `baseline_probability` | 16 | 29.10 (23.23–33.72) | 19.79 (14.72–43.80) | 1.71 | 1.47× | 6.0 | 5.4 |
| `condition_tree_rules` | 1 | 24.88 (21.19–32.12) | 19.86 (15.61–21.56) | 1.87 | 1.25× | 6.0 | 5.4 |
| `condition_tree_rules` | 16 | 25.23 (20.89–28.79) | 19.37 (17.51–24.30) | 2.01 | 1.30× | 6.0 | 5.4 |
| `weighted_pool` | 1 | 29.87 (23.46–46.99) | 20.46 (13.85–23.95) | 1.96 | 1.46× | 6.0 | 5.4 |
| `weighted_pool` | 16 | 26.42 (23.36–32.50) | 18.49 (15.21–41.52) | 1.98 | 1.43× | 6.0 | 5.4 |

> 该规模主要用于观察固定开销：模拟核心耗时约 `1.6–4.0 ms`（两端均不含进程启动，主要受线程创建、文件创建/原子替换及 C++ 端管道事件传递影响）；分析进程总耗时的绝大部分为 Windows 进程创建成本（Rust 进程内分析仅 `1.7–2.0 ms`）。

## 结果：10,000 runs（5 次独立重复）

### 模拟 → GSR

| 配置 | 线程 | C++ 中位数（范围）ms | Rust 中位数（范围）ms | C++ / Rust | C++ 内存 MiB | Rust 内存 MiB | C++ GSR B | Rust GSR B | C++ `total_result` | Rust `total_result` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline_probability` | 1 | 22.89 (21.36–25.48) | 7.62 (7.10–8.37) | 3.00× | 6.3 | 5.7 | 120,143 | 120,135 | 156,831 | 156,615 |
| `baseline_probability` | 16 | 7.95 (7.17–8.88) | 4.41 (3.96–5.11) | 1.80× | 6.4 | 5.8 | 120,143 | 120,631 | 156,831 | 156,615 |
| `condition_tree_rules` | 1 | 22.67 (21.75–23.94) | 7.52 (6.50–7.89) | 3.01× | 6.2 | 5.7 | 120,128 | 120,132 | 60,000 | 60,000 |
| `condition_tree_rules` | 16 | 7.43 (6.91–8.00) | 5.11 (4.06–5.39) | 1.45× | 6.4 | 5.9 | 120,128 | 120,628 | 60,000 | 60,000 |
| `weighted_pool` | 1 | 42.90 (40.56–43.45) | 14.37 (12.83–14.58) | 2.99× | 6.2 | 5.7 | 120,143 | 120,135 | 330,245 | 331,335 |
| `weighted_pool` | 16 | 10.20 (8.90–10.89) | 5.47 (5.04–6.34) | 1.86× | 6.5 | 6.0 | 120,143 | 120,631 | 330,245 | 331,335 |

### GSR → Analysis JSON

| 配置 | 来源线程 | C++ 进程中位数（范围）ms | Rust 进程中位数（范围）ms | Rust 进程内中位数 ms | C++ / Rust（进程） | C++ 内存 MiB | Rust 内存 MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline_probability` | 1 | 29.02 (27.05–30.86) | 20.39 (17.23–20.85) | 2.10 | 1.42× | 6.1 | 5.4 |
| `baseline_probability` | 16 | 29.01 (26.61–32.97) | 20.08 (16.59–21.57) | 2.19 | 1.44× | 6.1 | 5.4 |
| `condition_tree_rules` | 1 | 30.59 (25.27–42.61) | 18.56 (13.78–23.92) | 2.14 | 1.65× | 6.1 | 5.4 |
| `condition_tree_rules` | 16 | 30.30 (24.00–31.20) | 20.84 (19.05–42.93) | 2.19 | 1.45× | 6.1 | 5.4 |
| `weighted_pool` | 1 | 27.31 (23.26–29.11) | 18.45 (16.47–42.51) | 2.33 | 1.48× | 6.1 | 5.4 |
| `weighted_pool` | 16 | 28.32 (27.63–30.31) | 21.40 (19.39–22.94) | 2.26 | 1.32× | 6.1 | 5.4 |

## 结果：1,000,000 runs（3 次独立重复）

### 模拟 → GSR

| 配置 | 线程 | C++ 中位数（范围）ms | Rust 中位数（范围）ms | C++ / Rust | C++ 内存 MiB | Rust 内存 MiB | C++ GSR B | Rust GSR B | C++ `total_result` | Rust `total_result` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline_probability` | 1 | 2082.56 (2063.78–2092.37) | 528.95 (496.94–598.31) | 3.94× | 17.4 | 5.7 | 12,000,143 | 12,001,111 | 15,715,969 | 15,700,053 |
| `baseline_probability` | 16 | 366.02 (360.31–400.10) | 131.07 (107.58–272.01) | 2.79× | 17.8 | 13.4 | 12,000,143 | 12,001,111 | 15,715,969 | 15,700,053 |
| `condition_tree_rules` | 1 | 2014.49 (1974.96–2110.75) | 524.66 (523.10–577.46) | 3.84× | 17.4 | 5.7 | 12,000,128 | 12,001,108 | 6,000,000 | 6,000,000 |
| `condition_tree_rules` | 16 | 372.25 (365.50–389.73) | 126.63 (107.45–231.72) | 2.94× | 17.8 | 12.4 | 12,000,128 | 12,001,108 | 6,000,000 | 6,000,000 |
| `weighted_pool` | 1 | 4215.99 (4211.97–4408.27) | 1257.83 (1140.99–1261.32) | 3.35× | 17.5 | 5.7 | 12,000,143 | 12,001,111 | 33,111,767 | 33,116,392 |
| `weighted_pool` | 16 | 617.81 (595.42–625.83) | 210.22 (184.37–259.11) | 2.94× | 17.8 | 12.3 | 12,000,143 | 12,001,111 | 33,111,767 | 33,116,392 |

### GSR → Analysis JSON

| 配置 | 来源线程 | C++ 进程中位数（范围）ms | Rust 进程中位数（范围）ms | Rust 进程内中位数 ms | C++ / Rust（进程） | C++ 内存 MiB | Rust 内存 MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline_probability` | 1 | 62.18 (55.67–67.66) | 53.73 (48.87–60.12) | 34.98 | 1.16× | 13.7 | 5.4 |
| `baseline_probability` | 16 | 66.56 (64.27–69.57) | 60.37 (57.67–61.49) | 39.98 | 1.10× | 13.7 | 5.4 |
| `condition_tree_rules` | 1 | 56.81 (48.55–58.59) | 57.00 (47.60–61.15) | 40.10 | 1.00× | 13.7 | 5.4 |
| `condition_tree_rules` | 16 | 69.36 (57.80–69.72) | 58.00 (55.67–64.29) | 37.91 | 1.20× | 13.7 | 5.4 |
| `weighted_pool` | 1 | 59.17 (57.97–62.17) | 56.14 (54.63–59.21) | 38.37 | 1.05× | 13.7 | 5.4 |
| `weighted_pool` | 16 | 62.95 (60.80–68.12) | 60.89 (56.95–63.92) | 40.52 | 1.03× | 13.7 | 5.4 |

## 差异说明

1. **随机流实现差异**：C++ 端对每个 run 使用 `std::mt19937_64`（312 个 `u64`、约 2.5 KiB 状态表，每次 run 重新初始化状态）配合 `std::uniform_real_distribution<double>`；Rust 端以 SplitMix64 从 `(seed, run_index)` 派生 256-bit `Xoshiro256++` 状态，并使用全精度 IEEE-754 均匀分布采样（>99.97% 仅消耗 1 次 `next_u64`）。该差异既解释了随机配置下 `total_result` 的小幅差异，也是 Rust 单线程吞吐大幅领先（`3.35–3.94×`）的主要原因之一。
2. **每 run 缓冲区复用**：Rust 端按 worker 线程复用 `Scratch` 缓冲（库存、once 标记、帧栈、收集动作列表），避免每次 run 重复堆分配；C++ 端每次 run 会构造独立 `State` 与内部 `std::vector`。
3. **GSR 布局与内存上界差异**：C++ 使用扁平 GSR v2，需先在内存中保留全部 `u64[total_runs]` 与 `u32[total_runs]` 数组（`1,000,000 runs` 约 12 MiB，十亿 runs 时约 12 GiB），模拟结束后再顺序写出；Rust 使用分块流式 GSR v3，头部先写原因表，按有界窗口逐块写出配对记录（`100` / `10,000` runs 16 线程时会切分为更多小块，因此 GSR 体积略增数百字节；`1,000,000 runs` 按默认 `16,384` 条/块写出 62 块，体积仅比 v2 多 968 字节，且单线程模拟与流式分析的峰值工作集稳定在 `5.4–5.7 MiB`）。
4. **统计与落盘开销**：Rust `gachasimulate-cli` 在 `simulate` 结束后会以兄弟临时文件原子替换目标文件，并允许在结果文件已存在时安全保护旧文件；该额外文件重命名开销已计入 Rust `core_ms`。
