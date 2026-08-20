# GachaSimulate

Monte Carlo 抽卡模拟器。TypeScript Compiler 将 YAML 和本次选择的结果 item 编译为 IR，C++ Runtime 执行模拟并输出 GSR；C++ analyzer 为该 item 生成分析数据。

## WSL2/Linux 快速开始

日常开发和 CI 使用 WSL2/Linux bash；不要混用 Windows 侧的 Node、pnpm、C++ 工具或 `node_modules`。Electron 图形界面需要 WSLg。

开发环境需要 Node.js 24、pnpm 11.3.0、Clang、CMake 和 Ninja。首次安装依赖与 hook：

```bash
pnpm install --frozen-lockfile
pnpm run hooks:install
```

按 [Development Checks](docs/DEVELOPMENT_CHECKS.md) 完成 C++ Release install 后启动 Electron：

```bash
pnpm run dev
```

## Electron

桌面应用有独立的“结果编辑”和“结果可视化”页面；两页共享当前 GSR 会话。应用可以选择已安装配置，以指定 seed 和 threads 运行或取消模拟，打开结果目录，并选择 GSR 编辑展示字段。统计物品列表由 Compiler 从当前 `config.yaml` 的 `items` 读取；表单只按大小写敏感的完整 ID 选择，默认优先 `draw_count`，否则使用第一项。失焦保存生成：

- `<stem>.visualize.json`

sidecar 是独立的 `DisplayConfig v1`，只保存 `title`、`target`、`result_item_name`、`note`、`price` 和 `unit`；分析、result item ID、CDF、termination、total 和 runs 始终从 GSR 重新获取。

桌面数据位于 `app.getPath("userData")` 下的 `configs/installed/` 与 `results/`。

仓库的 `v*` tag workflow 会构建并测试 Windows 原生程序、生成 NSIS 安装包并发布 GitHub Release；是否已有公开 Release 以仓库 Release 页面为准。

## 可视化与导出

Electron 展示和 Remotion 导出共享 `AnalysisV2 + DisplayConfig v1` 输入、CDF 视图模型、画面与动画。导出命令：

```bash
pnpm run export:cdf -- --gsr <file.gsr> --display <file.visualize.json>
```

Remotion 导出固定 3840x2160、60fps 的 `cdf-animation.mp4` 和 `cdf-result.png`。使用或分发前请确认许可证条款。

## 开发检查

模块边界见 [Architecture](ARCHITECTURE.md)，push 前检查见 [Development Checks](docs/DEVELOPMENT_CHECKS.md)。
