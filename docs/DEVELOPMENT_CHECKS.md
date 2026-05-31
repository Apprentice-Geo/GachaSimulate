# Development Checks

本文档记录 push 前建议在本地执行的检查命令。目标是尽量在本地发现 CI 会拦截的问题，减少提交后再回头修复。

## 前置准备

安装 Python 依赖：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install -e .
```

安装 Node 依赖：

```powershell
npm ci
```

## Push 前全量检查

Python 检查：

```powershell
.\.venv\Scripts\python.exe -m ruff format --check .
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m pyright
.\.venv\Scripts\python.exe -m build --wheel --no-isolation
.\.venv\Scripts\python.exe -m pytest
```

前端检查：

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run build
npm run test:visualize:cdf
npm run test:e2e
```

这些命令覆盖当前 CI 的格式化、lint、类型检查、构建和测试门禁。`npm run build` 如果只输出 Vite chunk size warning 且退出码为 0，不会导致 CI 失败。

## 常见修复命令

如果 Python 格式检查失败，执行：

```powershell
.\.venv\Scripts\python.exe -m ruff format .
```

如果 Python lint 失败，先查看 `ruff check` 输出并修复对应文件。部分安全的自动修复可以用：

```powershell
.\.venv\Scripts\python.exe -m ruff check . --fix
```

如果前端格式检查失败，执行：

```powershell
npx prettier --write "src/visualize/**/*.{ts,tsx,css,json}" "e2e/**/*.ts" "docs/schemas/**/*.json" "*.{ts,json,html,mjs}"
```

如果前端 lint、TypeScript typecheck、Python pyright 或构建失败，优先按报错定位具体文件，不要用批量改动掩盖问题。

## 和 CI 的对应关系

- `ruff format --check .`：Python 格式化检查。
- `ruff check .`：Python lint。
- `pyright`：Python 类型检查。
- `python -m build --wheel --no-isolation`：Python wheel 构建检查。
- `npm run format:check`：前端和 schema 格式化检查。
- `npm run lint`：前端 ESLint 检查。
- `npm run typecheck`：TypeScript 类型检查。
- `npm run build`：前端生产构建检查。
- `pytest`、`test:visualize:cdf`、`test:e2e`：测试门禁。
