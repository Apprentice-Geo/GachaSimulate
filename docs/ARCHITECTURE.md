# Architecture

本文档记录 GachaSimulate 的稳定模块、信任边界和数据契约；具体行为以源码、测试及专项文档为准。

## 数据流

```text
config.yaml + termination.yaml + manifest.yaml
    + simulation result item
    -> @gachasimulate/config-compiler
    -> JSON IR
    -> gachasimulate-core
    -> GSR
    -> gachasimulate-analyze
    -> Analysis v2
    -> analysis_to_visualize
    -> VisualizeInput
```

GSR 是权威模拟结果，保存每次启动模拟前选择的 result item 期末库存。Electron 的“结果编辑”和“结果可视化”页面共享当前 GSR 会话。编辑后生成单一完整 `<stem>.visualize.json` sidecar；重新打开时只恢复五个展示字段，不从 sidecar 恢复统计。

## 代码地图

- `packages/config-compiler/`：唯一 YAML 校验和 IR 编译实现。
- `cpp/`：唯一模拟 Runtime、GSR 编解码、统计、core、analyzer 和 benchmark。
- `packages/cli/`：YAML→IR→core 与 GSR→analyzer 的命令行包装。
- `src/main/`：受信任的 Electron 文件系统、配置扫描、原生进程和结果编辑生命周期；扫描配置时通过 Compiler 读取并校验 `items`。
- `src/preload/`：只暴露固定 IPC 能力。
- `src/renderer/`：模拟表单、任务状态、结果编辑页和结果可视化页，不使用 Node.js。
- `src/visualize/`：平台无关的 `VisualizeInput` 校验、视图模型、浏览器入口和导出。
- `configs/`：本地配置与预置；`benchmark/cases/`：语言无关 benchmark case。

## 信任边界

Renderer 不能提供 executable、IR、GSR 输出路径或 analyzer 输入路径。main 从 `build/native/bin` 解析两个程序，只读取已安装配置，并在 `<userData>/results/` 生成唯一 GSR 路径。GSR 输入只来自 main 的系统文件对话框。

main 严格拒绝未知 SimulationRequest 字段。core/analyzer stdout、Analysis v2、sidecar 与 YAML/manifest 都在各自边界校验，并设置资源上限。应用关闭、取消、协议错误和异常退出必须终止原生进程树并清理临时 IR。

## 稳定不变量

- TS Compiler 是 YAML 到 IR 的唯一权威；C++ 不解析 YAML。
- C++ Runtime 是模拟执行的唯一权威。
- 固定次数返回精确 run 数；GSR 只保存所选 result item 的期末库存。
- `threads` 是受逻辑 CPU 数限制的正整数；Electron 只允许从当前配置按完整、大小写敏感的 ID 选择 result item，默认优先 `draw_count`、否则选择第一项，Compiler 再次验证并将其对应索引写入 IR。
- core 只写 GSR v2；analyzer 只输出 Analysis v2。
- sidecar 只允许编辑 `title`、`target`、`note`、`price`、`unit`。
- 修改 `VisualizeInput` 时同步 schema、类型、校验和测试。
- 配置仓库、安装包、分析详情和 CDF 同屏预览是后置能力。

语法见 [YAML Config Syntax](YAML_CONFIG_SYNTAX.md)，GSR 见 [GSR v2](GSR_V2.md)，分析见 [Analysis v2](ANALYSIS_V2.md)，可视化见 [Visualize Frontend Implementation](VISUALIZE_FRONTEND_IMPLEMENTATION.md)。
