# GachaSimulate

Monte Carlo 抽卡模拟器。TypeScript Compiler 将 YAML 和本次选择的结果 item 编译为 IR，C++ Runtime 执行模拟并输出 GSR；C++ analyzer 为该 item 生成分析数据。

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

桌面应用有独立的“结果编辑”和“结果可视化”页面；两页共享当前 GSR 会话。应用可以选择已安装配置，以指定 seed 和 threads 运行或取消模拟，打开结果目录，并选择 GSR 编辑展示字段。统计物品列表由 Compiler 从当前 `config.yaml` 的 `items` 读取；表单只按大小写敏感的完整 ID 选择，默认优先 `draw_count`，否则使用第一项。失焦保存生成：

- `<stem>.visualize.json`

sidecar 是独立的 `DisplayConfig v1`，只保存 `title`、`target`、`result_item_name`、`note`、`price` 和 `unit`；分析、result item ID、CDF、termination、total 和 runs 始终从 GSR 重新获取。

桌面数据位于 `app.getPath("userData")` 下的 `configs/installed/` 与 `results/`。

Electron 当前只支持从源码启动，安装包尚未实现。

## 可视化与导出

独立浏览器入口用于开发和调试，使用开发 fixture；桌面 Electron 负责组合 GSR 分析与 DisplayConfig：

```bash
pnpm run dev:web
```

```text
http://127.0.0.1:5173/?input=results/<stem>.visualize.json
```

构建与导出：

```bash
pnpm run build:web
pnpm run export:cdf -- --gsr <file.gsr> --display <file.visualize.json>
```

Remotion 导出固定 3840x2160、60fps 的 `cdf-animation.mp4` 和 `cdf-result.png`。使用或分发前请确认许可证条款。

## 开发检查

模块边界见 [Architecture](ARCHITECTURE.md)，push 前检查见 [Development Checks](docs/DEVELOPMENT_CHECKS.md)。
