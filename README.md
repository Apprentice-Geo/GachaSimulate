# GachaSimulate

Monte Carlo 抽卡模拟器。TypeScript Compiler 将 YAML 编译为 IR，C++ Runtime 执行模拟并输出 GSR；C++ analyzer 按 `draw` 或 `cost` 生成分析数据。

## WSL2/Linux 快速开始

日常开发和 CI 使用 WSL2/Linux bash；不要混用 Windows 侧的 Node、pnpm、C++ 工具或 `node_modules`。Electron 图形界面需要 WSLg。

开发环境需要 Node.js 24、pnpm 11.3.0、Clang、CMake 和 Ninja。首次安装依赖、构建 Release 原生产物并启动 Electron：

```bash
pnpm install --frozen-lockfile
cd cpp
cmake --preset linux-release
cmake --build --preset linux-release
ctest --preset linux-release
cmake --install ../build/cpp/linux-release --prefix ../build/native
cd ..
pnpm run dev
```

Electron 开发前必须存在 `build/native/bin/gachasimulate-core` 和 `gachasimulate-analyze`。

## Electron

桌面应用可以选择已安装配置，以指定 seed 和 threads 运行或取消模拟，打开结果目录，并选择 GSR 编辑展示字段。失焦保存生成：

- `<stem>.draw.visualize.json`
- `<stem>.cost.visualize.json`

sidecar 是完整的 `VisualizeInput`，但重新打开时统计、CDF、termination、metric、total 和 timestamp 始终从 GSR 重新分析，只恢复 `title`、`target`、`note`、`price` 和 `unit`。

安装目录为空时，应用会复制 `configs/presets/`。桌面数据位于 `app.getPath("userData")` 下的 `configs/installed/` 与 `results/`。

Electron 当前只支持从源码启动。安装包、远端配置仓库、分析详情和 CDF 同屏预览尚未实现。

## 命令行

构建 workspace CLI：

```bash
pnpm --dir packages/config-compiler build
pnpm --dir packages/cli build
```

从 YAML 生成 GSR 并分析：

```bash
pnpm exec gachasimulate simulate --config-dir configs/presets/basic_probability --termination termination.yaml --total-runs 10 --output results/example.gsr
pnpm exec gachasimulate analyze --input results/example.gsr --metric draw
```

`simulate` 也支持 `--target-total-draw`、`--seed`（默认 `0`）和 `--threads`（默认 `1`）。输出必须是尚不存在的 `.gsr`；`analyze` 输出 [Analysis v1](docs/ANALYSIS_V1.md)。

## 可视化与导出

独立浏览器入口用于开发和调试，继续消费完整 `VisualizeInput`：

```bash
pnpm run dev:web
```

```text
http://127.0.0.1:5173/?input=results/<stem>.draw.visualize.json
```

构建与导出：

```bash
pnpm run build:web
pnpm run export:cdf -- --input <json文件路径>
```

Remotion 导出固定 3840x2160、60fps 的 `cdf-animation.mp4` 和 `cdf-result.png`。使用或分发前请确认许可证条款。

## 开发检查

模块边界见 [Architecture](docs/ARCHITECTURE.md)，push 前检查见 [Development Checks](docs/DEVELOPMENT_CHECKS.md)。
