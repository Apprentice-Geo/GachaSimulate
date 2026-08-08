# GachaSimulate

Monte Carlo 抽卡模拟器。项目使用 YAML 描述抽卡规则，输出 `.npz` 模拟结果和 `_visualize.json` 可视化输入。

## 环境配置

运行 Python CLI 需要：

- Python 3.12 或更高版本
- uv

Electron、可视化和导出还需要：

- Node.js
- pnpm 11.3.0

安装 Python 依赖：

```powershell
uv sync
```

安装 Node 依赖：

```powershell
pnpm install --frozen-lockfile
```

## Electron 开发环境

启动桌面应用：

```powershell
pnpm run dev
```

桌面应用可以选择已安装配置、运行或取消模拟、打开结果目录，以及加载 `_visualize.json`。每次开发启动时，如果安装目录为空，应用会复制 `configs/presets/` 中的预置配置。

Electron 当前只支持从仓库源码启动的开发环境，并以 Windows 11 作为桌面 MVP 验收环境。它不包含安装包、内置 Python、代码签名、自动更新或无开发环境运行能力。配置仓库尚未实现。

桌面运行数据由 Electron 写入 `app.getPath("userData")`：

```text
<userData>/
├─ configs/installed/
└─ results/
```

桌面进程边界和配置仓库的长期决策见 [Architecture](<docs/ARCHITECTURE.md>)。

## 命令行模拟

按固定模拟次数运行：

```powershell
uv run gachasimulate --config test --termination termination --total-runs 10
```

按总抽数目标运行：

```powershell
uv run gachasimulate --config test --termination termination --target-total-draw 100
```

按配置中的 `cost` item 生成成本维度可视化：

```powershell
uv run gachasimulate --config test --termination termination --total-runs 10 --metric cost
```

默认输出到 `results/`，包括 `.npz` 结果文件和 `_visualize.json` 可视化输入文件。常用参数：

- `--config`：`configs/` 下的配置目录名。
- `--config-dir`：显式配置目录，与 `--config` 互斥。
- `--termination`：终止条件 YAML 文件名；使用 `--config-dir` 时必须是该配置目录内的相对文件名，不能包含子目录路径。
- `--seed`：随机种子，默认 `0`。
- `--workers`：并行 worker 数，默认 `1`。
- `--metric`：可视化统计维度，可选 `draw` 或 `cost`，默认 `draw`；不改变模拟停止条件。
- `--results-dir`：输出目录，默认 `results/`。
- `--output-format jsonl`：向 stdout 输出供桌面端消费的 JSONL 事件；默认仍为人类可读文本。

使用 `--metric cost` 时，配置必须声明 `cost` item 并通过 actions 自行累计。生成的 JSON 中 `price` 和 `unit` 默认为空字符串，可按展示需要直接编辑。

## 可视化与导出

当前仍保留独立浏览器入口，主要用于开发和调试，不作为长期产品能力承诺：

```powershell
pnpm run dev:web
```

打开项目内的可视化 JSON：

```text
http://127.0.0.1:5173/?input=results/<file>_visualize.json
```

浏览器构建和预览：

```powershell
pnpm run build:web
pnpm run preview
```

`pnpm run build` 构建 Electron main、preload 和 renderer，不是浏览器入口的构建命令。

导出 CDF 可视化素材：

```powershell
pnpm run export:cdf -- --input <json文件路径>
```

导出当前使用 [Remotion](<https://github.com/remotion-dev/remotion>) 逐帧渲染固定 3840x2160、60fps 的 CDF 画面，默认输出到 `outputs/`：

- `cdf-animation.mp4`
- `cdf-result.png`

使用或分发当前 Remotion 导出实现时，请自行确认符合其许可证条款。可视化与导出的设计边界见 [Visualize Frontend Implementation](<docs/VISUALIZE_FRONTEND_IMPLEMENTATION.md>)。

## 开发检查

Push 或提交 PR 前，按 [Development Checks](<docs/DEVELOPMENT_CHECKS.md>) 执行与改动范围匹配的检查。
