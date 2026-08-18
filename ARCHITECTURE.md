# Architecture

本文档提供 GachaSimulate 的代码地图，帮助贡献者判断“功能在哪里”和“改动应落在哪一层”。这里只记录稳定边界；具体协议、参数和检查命令见专项文档。

## 鸟瞰

GachaSimulate 将 YAML 抽卡规则编译为中间表示，由 C++ Runtime 执行 Monte Carlo 模拟并保存 GSR。analyzer 从 GSR 生成平台无关的分析数据，供 Electron 展示和素材导出使用。Electron 负责组织这条流水线，不实现模拟语义。

```text
YAML -> Config Compiler -> IR -> C++ Runtime -> GSR -> Analyzer -> Analysis
     -> analysis_to_visualize -> VisualizeInput
```

## 代码地图

- `packages/config-compiler/`：YAML 校验与 IR 编译；单次编译入口是 `compile_yaml`，配置仓库批量校验入口是 `validate_config_files`。
- `packages/config-repository-contract/`：配置仓库 index、manifest 和包文件清单的纯协议校验；不执行网络、ZIP 或文件系统操作。
- `cpp/`：Runtime 执行 IR；同层还包含 GSR 编解码、统计、core、analyzer 和 benchmark。
- `src/main/`：受信任的 Electron 宿主；`SimulationTask` 管理 core 与模拟产物，`ResultEditor` 管理 analyzer 与结果会话。
- `src/preload/`：main 与 renderer 之间的固定 IPC 桥。
- `src/renderer/`：桌面界面与任务状态，不直接访问 Node.js。
- `src/visualize/`：平台无关的输入校验、视图模型和共享场景，以 `VisualizeInput` 为边界。
- `src/export/`：文件系统和 Remotion 导出宿主，依赖 `src/visualize/`。
- `test-fixtures/configs/`：主仓库测试与语义 fixture；`benchmark/cases/`：独立 benchmark 配置。
- 正式配置由 `GachaSimulate-Configs` 维护，不纳入主仓库运行时目录。

## 边界与不变量

- Config Compiler 是 YAML 到 IR 的唯一权威；C++ 不解析 YAML。
- C++ Runtime 是模拟语义的唯一权威；GSR 是持久化模拟结果，analyzer 不重新模拟。
- 固定 `global_seed` 时，每个 run 的随机流只由 `global_seed + run_index` 派生，不依赖 threads、chunk 数、执行顺序或 `total_runs`。该算法不兼容旧版基于 chunk 的随机序列，因此切换后相同 seed 的历史结果会改变一次；跨标准库的浮点分布也不承诺逐位一致。
- Electron renderer 不决定可执行文件和受信任文件路径；这些能力只存在于 main，并通过 preload 暴露固定操作。
- `src/visualize/` 不依赖 Electron、Node.js 或导出宿主；Electron 展示与素材导出复用同一套输入处理和场景。
- 启动原生进程的一层负责终止、等待和清理；失败任务不得留下临时 IR 或半成品结果。
- IR、GSR、Analysis 和 VisualizeInput 是跨层契约。修改契约时必须同时检查生产方、消费方和行为测试。

## 专项文档

配置语法见 `docs/YAML_CONFIG_SYNTAX.md`，结果格式见 `docs/GSR_V2.md`，分析格式见 `docs/ANALYSIS_V2.md`，可视化边界见 `docs/VISUALIZE_FRONTEND_IMPLEMENTATION.md`，检查矩阵见 `docs/DEVELOPMENT_CHECKS.md`。
