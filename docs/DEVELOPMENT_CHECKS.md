# Development Checks

本文档记录 push 前建议在本地执行的检查命令。目标是尽量在本地发现 CI 会拦截的问题，减少提交后再回头修复。

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

前端检查：

```powershell
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:visualize:cdf
pnpm run test:e2e
```

这些命令覆盖当前 CI 的格式化、lint、类型检查、构建和测试门禁。`pnpm run build` 如果只输出 Vite chunk size warning 且退出码为 0，不会导致 CI 失败。

## 常见修复命令

如果 Python 格式检查失败，执行：

```powershell
uv run ruff format .
```

如果 Python lint 失败，先查看 `ruff check` 输出并修复对应文件。部分安全的自动修复可以用：

```powershell
uv run ruff check . --fix
```

如果前端格式检查失败，执行：

```powershell
pnpm run format
```

如果前端 lint、TypeScript typecheck、Python pyright 或构建失败，优先按报错定位具体文件，不要用批量改动掩盖问题。

## 和 CI 的对应关系

- `ruff format --check .`：Python 格式化检查。
- `ruff check .`：Python lint。
- `pyright`：Python 类型检查。
- `uv build --wheel`：Python wheel 构建检查。
- `pnpm run format:check`：前端和 schema 格式化检查。
- `pnpm run lint`：前端 ESLint 检查。
- `pnpm run typecheck`：TypeScript 类型检查。
- `pnpm run build`：前端生产构建检查。
- `pytest`、`test:visualize:cdf`、`test:e2e`：测试门禁。
