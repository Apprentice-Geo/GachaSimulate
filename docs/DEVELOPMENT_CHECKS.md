# Development Checks

本文档记录 push 前建议执行的检查。先运行与改动直接相关的检查，准备提交或完成跨层改动时再运行全量矩阵。

## 前置准备

安装 Python 依赖：

```powershell
uv sync
```

安装 Node 依赖：

```powershell
pnpm install --frozen-lockfile
```

## Push 前全量检查

Python 检查：

```powershell
uv run ruff format --check .
uv run ruff check .
uv run pyright
uv build --wheel
uv run pytest
```

Electron、TypeScript 和可视化检查：

```powershell
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:simulation
pnpm run test:visualize:cdf
pnpm run test:e2e
```

这些命令覆盖当前 CI 的格式化、lint、类型检查、Electron 构建和测试门禁。`pnpm run build` 构建 Electron main、preload 和 renderer；它不是独立浏览器入口的构建命令。只出现 Vite chunk size warning 且退出码为 `0` 时，检查仍视为通过。

## 按影响范围选择检查

- Python 模拟、配置语义、CLI 或结果保存：运行对应 pytest 后，至少运行 Python 格式、lint 和类型检查。
- Electron 配置扫描、IPC、任务状态或进程生命周期：运行 `pnpm run test:simulation`、`pnpm run typecheck` 和 `pnpm run build`。
- 可视化输入、CDF、marker、统计展示或动画：运行 `pnpm run test:visualize:cdf` 和 `pnpm run test:e2e`。
- 独立浏览器入口：额外运行 `pnpm run build:web`。该入口目前用于开发和调试，不属于长期产品能力。
- 导出规格或画面：运行可视化检查，并使用代表性输入执行 `pnpm run export:cdf -- --input <json文件路径>` 检查 PNG 和 MP4。
- 仅修改文档：人工检查内容、命令和链接；若文档描述跨层完成状态，仍按其影响范围运行对应检查。

## Electron 人工验收

`pnpm run dev` 是交互式开发命令，不在 CI 中运行。修改桌面流程后，应按影响范围人工确认：

- 单窗口应用能够启动，三个页面可以切换。
- 固定次数和累计抽数能够使用串行或多进程运行，并显示状态、进度和结果。
- 活动任务期间不能开始第二个任务。
- 取消多进程任务或在运行中关闭应用后，没有残留 Python worker。
- 模拟完成后可以打开结果目录。
- 合法 `_visualize.json` 可以展示，读取失败或输入不合法时应用不会崩溃。

## 常见修复命令

如果 Python 格式检查失败，执行：

```powershell
uv run ruff format .
```

如果 Python lint 失败，先查看 `ruff check` 输出。部分安全的自动修复可以用：

```powershell
uv run ruff check . --fix
```

如果 Node 侧格式检查失败，执行：

```powershell
pnpm run format
```

如果 ESLint、TypeScript、pyright 或构建失败，优先按报错定位具体文件，不要用批量改动掩盖问题。

## 和 CI 的对应关系

- `ruff format --check .`：Python 格式化检查。
- `ruff check .`：Python lint。
- `pyright`：Python 类型检查。
- `uv build --wheel`：Python wheel 构建检查。
- `pnpm run format:check`：TypeScript、CSS 和 schema 格式化检查。
- `pnpm run lint`：TypeScript 和 React ESLint 检查。
- `pnpm run typecheck`：Electron、共享类型和可视化 TypeScript 类型检查。
- `pnpm run build`：Electron main、preload 和 renderer 构建检查。
- `pytest`、`test:simulation`、`test:visualize:cdf`、`test:e2e`：Python、Electron 和可视化行为门禁。
