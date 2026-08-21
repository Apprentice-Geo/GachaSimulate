# Architecture

本文档提供 GachaSimulate 的代码地图，帮助贡献者判断“功能在哪里”和“改动应落在哪一层”。这里只记录稳定边界；具体协议、参数和检查命令见专项文档。

## 鸟瞰

GachaSimulate 将 YAML 抽卡规则编译为中间表示，由 C++ Runtime 执行 Monte Carlo 模拟并保存 GSR。analyzer 从 GSR 生成平台无关的分析数据，供 Electron 展示和素材导出使用。Electron 负责组织这条流水线，不实现模拟语义。

```text
YAML -> Config Compiler -> IR -> C++ Runtime -> GSR -> Analyzer -> Analysis
     -> AnalysisV2 + DisplayConfig v1 -> CDF ViewModel
```

## 代码地图

- `packages/config-compiler/`：YAML 校验与 IR 编译；单次编译入口是 `compile_yaml`，配置仓库批量校验入口是 `validate_config_files`。
- `packages/config-repository-contract/`：配置仓库 index、manifest 和包文件清单的纯协议校验；不执行网络、ZIP 或文件系统操作。
- `cpp/`：Runtime 执行 IR；同层还包含 GSR 编解码、统计、core、analyzer 和 benchmark。
- `src/main/`：受信任的 Electron 宿主；`SimulationTask` 管理 core 与模拟产物，`ResultEditor` 管理 analyzer 与结果会话。
- `src/preload/`：main 与 renderer 之间的固定 IPC 桥。
- `src/renderer/`：桌面界面与任务状态，不直接访问 Node.js。
- `src/visualize/`：平台无关的 AnalysisV2/DisplayConfig 校验、CDF 视图模型和共享场景。
- `src/export/`：文件系统和 Remotion 导出宿主，依赖 `src/visualize/`。
- `test-fixtures/configs/`：主仓库测试与语义 fixture；`benchmark/cases/`：独立 benchmark 配置。
- 正式配置由 `GachaSimulate-Configs` 维护，不纳入主仓库运行时目录。

## 边界与不变量

- Config Compiler 是 YAML 到 IR 的唯一权威；C++ 不解析 YAML。
- Config Compiler 定义 IR 的结构及 YAML 到 IR 的表示规则；C++ loader 将临时 IR 文件视为不可信输入并执行防御性校验，但不独立扩展 IR 表示。IR 只用于配套版本的 Compiler 与 Runtime 之间传递单次任务，不是持久化或跨版本兼容格式。
- C++ Runtime 是模拟语义的唯一权威；GSR 是持久化模拟结果，analyzer 不重新模拟。
- 固定 `global_seed` 时，每个 run 的随机流只由 `global_seed + run_index` 派生，不依赖 threads、chunk 数、执行顺序或 `total_runs`。该算法不兼容旧版基于 chunk 的随机序列，因此切换后相同 seed 的历史结果会改变一次；跨标准库的浮点分布也不承诺逐位一致。
- Electron renderer 不决定可执行文件和受信任文件路径；这些能力只存在于 main，并通过 preload 暴露固定操作。
- `src/visualize/` 不依赖 Electron、Node.js 或导出宿主；Electron 展示与素材导出复用同一套输入处理和场景。
- 启动原生进程的一层负责终止、等待和清理；失败任务不得留下临时 IR 或半成品结果。
- 修改跨层契约时，必须同时检查生产方、消费方、机器定义、兼容策略和行为测试。

## 契约索引

| 契约 | 用途与边界 | 版本与兼容性 | 定义权威 | 生产方 | 消费方 | 文档 |
| --- | --- | --- | --- | --- | --- | --- |
| YAML Config | 用户配置输入 | schema v2 | Config Compiler validator | 配置作者 | Config Compiler | [`YAML_CONFIG_SYNTAX.md`](docs/YAML_CONFIG_SYNTAX.md) |
| IR | TS 到 C++ 的临时 JSON 进程契约 | IR v2；只支持配套版本，不持久化 | Config Compiler；C++ loader 负责不可信输入防御 | Config Compiler | C++ Runtime | [`IR_V2.md`](docs/IR_V2.md) |
| GSR | 持久化模拟结果 | GSR v2；不读取旧格式 | C++ codec 与固定 fixture | C++ Runtime | C++ analyzer | [`GSR_V2.md`](docs/GSR_V2.md) |
| Analysis | analyzer 的 JSON 输出 | AnalysisV2；不隐式兼容旧字段 | JSON Schema 定义结构，semantic validator 定义跨字段不变量 | C++ analyzer | Electron、素材导出 | [`ANALYSIS_V2.md`](docs/ANALYSIS_V2.md) |
| DisplayConfig | 独立可视化 sidecar | v1；不隐式兼容旧字段 | JSON Schema | Electron 结果编辑 | Electron、素材导出 | [`VISUALIZE_FRONTEND_IMPLEMENTATION.md`](docs/VISUALIZE_FRONTEND_IMPLEMENTATION.md) |
| Config Repository | 配置仓库 index、manifest 和包文件集合 | v1 | config-repository-contract validator | 配置仓库 | Electron 配置安装 | [`CONFIG_REPOSITORY_V1.md`](docs/CONFIG_REPOSITORY_V1.md) |

JSON 契约按约束范围划分权威：JSON Schema 定义字段、类型、必填项和局部取值约束；semantic validator 定义 Schema 之外的跨字段不变量；TypeScript 类型只是消费方的静态视图。契约测试负责验证这些定义与生产方、消费方保持一致，不另行定义格式。

## 专项文档

配置语法见 `docs/YAML_CONFIG_SYNTAX.md`，IR 见 `docs/IR_V2.md`，配置仓库协议见 `docs/CONFIG_REPOSITORY_V1.md`，结果格式见 `docs/GSR_V2.md`，分析格式见 `docs/ANALYSIS_V2.md`，可视化边界见 `docs/VISUALIZE_FRONTEND_IMPLEMENTATION.md`，检查矩阵见 `docs/DEVELOPMENT_CHECKS.md`。
