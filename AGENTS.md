# AGENTS.md

## 文档入口

- 安装、运行和常用命令：[README](<README.md>)。
- 项目代码地图、模块边界和稳定不变量：[Architecture](<docs/ARCHITECTURE.md>)。
- YAML 配置语法与执行顺序：[YAML Config Syntax](<docs/YAML_CONFIG_SYNTAX.md>)。
- 可视化设计决策和维护边界：[Visualize Frontend Implementation](<docs/VISUALIZE_FRONTEND_IMPLEMENTATION.md>)。
- 按影响范围选择检查及 push 前完整矩阵：[Development Checks](<docs/DEVELOPMENT_CHECKS.md>)。

## 默认开发环境与启动入口

- 默认在仓库根目录使用 WSL2/Linux bash 开发；Electron 界面通过 WSLg 运行。Node、pnpm、Python 和 uv 都必须使用 WSL 内安装的版本，不要混用 Windows 可执行文件或 `node_modules`。
- 首次准备环境：`uv sync --locked`，然后执行 `pnpm install --frozen-lockfile`。
- 启动 Electron 桌面应用：`pnpm run dev`。Electron 会从同一个 WSL 环境调用 `uv run gachasimulate`，无需单独启动 Python 服务。
- `pnpm run dev:web` 只启动独立浏览器可视化入口，不是桌面应用。
- C++ 日常开发与 CI 使用 WSL2/Linux + Clang + Ninja；Windows 最终构建留给打包/CD 流程。完整环境说明和检查矩阵见 Development Checks。

除上述默认入口外，不要在本文件复制链接文档中的详细命令、配置语法或实现清单。文档与实现冲突时，以源码和行为测试为准，并修正对应文档。

## 修改边界

- 修改 YAML 语法或配置合法性时，按 `docs/YAML_CONFIG_SYNTAX.md` 同步检查 `validator.py`、`builder.py` 和相关测试。
- 修改单次模拟语义时，先对齐 `docs/YAML_CONFIG_SYNTAX.md` 中的执行顺序，再检查 `runtime.py`、`engine.py` 和行为测试。
- 修改 CLI 或保存结果时，确认 `.npz` 与 `_visualize.json` 成对输出，并验证可视化输入消费方仍能读取生成的 JSON。
- 修改 Electron IPC、配置扫描或模拟任务生命周期时，保持 `docs/ARCHITECTURE.md` 中的 main、preload、renderer 信任边界，并更新共享类型和 Electron 行为测试。
- 修改可视化输入、CDF、marker、统计展示、动画或导出时，遵循 `docs/VISUALIZE_FRONTEND_IMPLEMENTATION.md` 的维护边界和共享契约。
- 修改 benchmark 时，优先覆盖完整批量模拟路径；跨 case 对比性能时注意不同配置的 `total_draw` 可能不同。

## 容易忽略的行为

- `simulate_until_total_draw()` 以累计抽数目标停止，最终 `total_draw` 可能大于请求值。
- `simulate_fixed_runs()` 用于固定 run 数场景，benchmark 默认使用它做小规模稳定测量。

## 提交信息

Commit message 遵循 [Conventional Commits](<https://www.conventionalcommits.org/en/v1.0.0/>)：

```text
<type>(<scope>): <简短描述>

[可选的详细说明]
```
