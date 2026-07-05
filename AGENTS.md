# GachaSimulate 开发说明

本文档只记录本仓库的项目约定。通用编码协作原则已经迁移到 skill，不在这里重复维护。

## 项目结构

- `src/gachasimulate/`：Python 模拟核心。
  - `validator.py` 校验 YAML 配置和终止条件。
  - `builder.py` 将 YAML 编译为运行期结构。
  - `runtime.py` 定义运行期数据结构、Action、Condition、Rule、Pool、Item。
  - `engine.py` 执行单次模拟。
  - `core.py` 执行批量模拟、结果保存、结果加载和可视化输入生成。
  - `cli.py` 提供 `uv run gachasimulate` 命令入口。
- `configs/`：真实抽卡组合配置。配置语法以 `docs/YAML_CONFIG_SYNTAX.md` 为准。
- `tests/`：Python 行为测试。
- `benchmark/`：基准配置与 `pytest-benchmark` 性能测试。
- `src/visualize/`：React/Vite 可视化前端。
- `docs/schemas/visualize_input.schema.json`：前端可视化输入 JSON schema。
- `docs/ARCHITECTURE.md`：模拟核心架构和运行语义说明。
- `docs/VISUALIZE_FRONTEND_IMPLEMENTATION.md`：可视化前端实现和维护边界。
- `docs/DEVELOPMENT_CHECKS.md`：push 前完整检查清单。

## 环境与常用命令

安装 Python 依赖：

```powershell
uv sync
```

安装前端依赖：

```powershell
pnpm install --frozen-lockfile
```

运行模拟：

```powershell
uv run gachasimulate --config test --termination termination --total-runs 10
uv run gachasimulate --config test --termination termination --target-total-draw 100
```

启动可视化：

```powershell
pnpm run dev
```

打开项目内可视化 JSON：

```text
http://127.0.0.1:5173/?input=results/<file>_visualize.json
```

导出 CDF 可视化素材：

```powershell
pnpm run export:cdf -- --input <json文件路径>
```

## 检查命令

Python 检查：

```powershell
uv run ruff format --check .
uv run ruff check .
uv run pyright
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

benchmark：

```powershell
uv run pytest benchmark --benchmark-only
```

文档改动通常只需要人工检查。运行代码、配置语义、导出契约或前端展示改动，应选择与影响范围匹配的检查；完整 push 前矩阵见 `docs/DEVELOPMENT_CHECKS.md`。

## 修改边界

- 修改 YAML 语法或配置合法性时，同步检查 `validator.py`、`builder.py`、`docs/YAML_CONFIG_SYNTAX.md` 和相关测试。
- 修改单次模拟语义时，先对齐 `docs/ARCHITECTURE.md` 中的执行顺序、Action 链、rule phase、resolve 和 termination 约定。
- 修改 CLI 或保存结果时，确认 `.npz` 与 `_visualize.json` 成对输出，并验证前端仍能读取生成的 JSON。
- 修改可视化输入结构时，同步更新 schema、`src/visualize/types/visualize_input.ts`、`src/visualize/data/validate_input.ts` 和相关测试。
- 修改 CDF 计算、marker、统计展示或动画节奏时，优先在 `src/visualize/view/`、`src/visualize/data/`、`src/visualize/animation/` 内维护对应逻辑，避免把业务计算散进组件。
- 修改前端视觉时，保持现有深色数据监控台风格；具体边界以 `docs/VISUALIZE_FRONTEND_IMPLEMENTATION.md` 为准。
- 修改 benchmark 时，优先覆盖完整批量模拟路径；跨 case 对比性能时注意不同配置的 `total_draw` 可能不同。

## 配置与契约注意事项

- `config.yaml` 必须包含 `draw_count` item，且 `every_draw` 需要推进 `draw_count`。
- `termination*.yaml` 使用 condition tree，终止原因由命中路径上的 `terminate ...` action 设置。
- `item_resolve` 是获得物品后的即时处理，不是独立 resolve phase；避免配置循环分解链。
- `simulate_until_total_draw()` 以总抽数目标停止，最终 `total_draw` 可能大于请求值。
- `simulate_fixed_runs()` 用于固定 run 数场景，benchmark 默认使用它做小规模稳定测量。
- 可视化 JSON 是 Python 输出和前端读取之间的共享契约，不能只按 Python 侧行为判断是否正确。

## 提交信息

需要写 commit message 时使用 Conventional Commits，例如：

```text
docs: update project agent instructions
```
