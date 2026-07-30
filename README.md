# GachaSimulate

Monte Carlo 抽卡模拟器。项目从 `configs/` 下的 YAML 配置运行模拟，输出 `.npz` 结果和前端可视化使用的 JSON。

## 环境配置

需要准备：

- Python 3.12 或更高版本
- uv
- Node.js
- pnpm 11.3.0

安装 Python 依赖：

```powershell
uv sync
```

安装前端依赖：

```powershell
pnpm install --frozen-lockfile
```

## 运行模拟

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
- `--termination`：终止条件 YAML 文件名，可省略 `.yaml` 后缀。
- `--seed`：随机种子，默认 `0`。
- `--workers`：并行 worker 数，默认 `1`。
- `--metric`：可视化统计维度，可选 `draw` 或 `cost`，默认 `draw`；不改变模拟停止条件。
- `--results-dir`：输出目录，默认 `results/`。

使用 `--metric cost` 时，配置必须声明 `cost` item 并通过 actions 自行累计。生成的 JSON 中 `price` 和 `unit` 默认为空字符串，可按展示需要直接编辑。

## 启动可视化

启动开发服务：

```powershell
pnpm run dev
```

打开项目内的可视化 JSON：

```text
http://127.0.0.1:5173/?input=results/<file>_visualize.json
```

也可以在页面中手动导入 JSON 文件。

生产构建和预览：

```powershell
pnpm run build
pnpm run preview
```

导出 CDF 可视化素材：

```powershell
pnpm run export:cdf -- --input <json文件路径>
```

导出使用 [Remotion ](https://github.com/remotion-dev/remotion) 逐帧渲染固定 3840x2160、60fps 的 CDF 画面，默认输出到 `outputs/`：

- `cdf-animation.mp4`
- `cdf-result.png`

本项目将 Remotion 作为导出层依赖。使用或分发导出功能时，请自行确认符合 Remotion 当前许可证条款。

## CI 检查

Push 或提交 PR 前检查 [docs/DEVELOPMENT_CHECKS.md](docs/DEVELOPMENT_CHECKS.md) 中的 CI 项目。
