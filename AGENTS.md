# AGENTS.md

## 文档入口

- 安装、运行和常用命令：[README](<README.md>)。
- 项目代码地图、模块边界和稳定不变量：[Architecture](<ARCHITECTURE.md>)。
- YAML 配置语法与执行顺序：[YAML Config Syntax](<docs/YAML_CONFIG_SYNTAX.md>)。
- Compiler 与 C++ Runtime 间的中间表示契约：[IR](<docs/IR.md>)。
- 配置仓库 index、manifest 与包协议：[Config Repository v1](<docs/CONFIG_REPOSITORY_V1.md>)。
- 持久化结果与分析输出格式：[GSR v2](<docs/GSR_V2.md>)、[Analysis JSON](<docs/ANALYSIS.md>)。
- 独立展示配置与保存契约：[DisplayConfig](<docs/DISPLAY_CONFIG.md>)。
- UI 设计原则与交互不变量：[UI Design](<docs/UI_DESIGN.md>)。
- 按影响范围选择检查及 push 前完整矩阵：[Development Checks](<docs/DEVELOPMENT_CHECKS.md>)。
- FFmpeg 源码准备、构建脚本职责与材料收集：[scripts README](<scripts/README.md>)。
- 此处未列出的文档视作开发临时文档，不承诺长期存在和有效。

## 开发环境与启动入口

- 仓库唯一维护的开发、构建和检查基准是 Windows x64。Node/pnpm 在 Windows 原生环境运行；C++ 使用 MSYS2 UCRT64 GCC、CMake 和 Ninja，格式化与静态分析使用同一 UCRT64 环境中的 Clang 工具。
- 不要复用 WSL/Linux 的 `node_modules`、CMake 构建目录或已安装的原生程序。
- 首次准备环境：`pnpm install --frozen-lockfile`，再按 Development Checks 完成 C++ Release install。
- 启动 Electron 桌面应用：`pnpm run dev`。Electron 直接调用 `build/native/bin` 中的 core 和 analyzer。
- 修改 Electron UI 后，建议使用 `pnpm run capture:ui [场景名]` 截取真实渲染结果，并查看项目内 `tmp/ui-captures/` 的图片；省略场景名时截取全部内置状态。
- CI 使用 Windows x64 + MSYS2 UCRT64 GCC + Ninja 作为标准检查基准。完整环境说明和检查矩阵见 Development Checks。

除上述默认入口外，不要在本文件复制链接文档中的详细命令、配置语法或实现清单。文档与实现冲突时，以源码和行为测试为准，并修正对应文档。

## 修改边界

- 修改 YAML 语法或配置合法性时，按 `docs/YAML_CONFIG_SYNTAX.md` 同步检查 TS Compiler 和相关测试；若改变 IR，继续按 `docs/IR.md` 检查 C++ loader。Compiler 定义 IR，C++ 只负责不可信输入防御。
- 修改配置仓库 index、manifest 或包文件集合时，按 `docs/CONFIG_REPOSITORY_V1.md` 检查 contract package、安装流程和相关测试。
- 修改单次模拟语义时，先对齐 `docs/YAML_CONFIG_SYNTAX.md` 中的执行顺序，再检查 C++ Runtime 和行为测试。
- 修改 CLI 或保存结果时，确认启动请求选择 result item、Compiler 写入对应 IR 索引、GSR v2、Analysis 和独立 DisplayConfig `*.visualize.json` sidecar 契约，并验证 Electron 展示与素材导出仍能消费 `Analysis + DisplayConfig`。
- 修改 Electron IPC、配置扫描或模拟任务生命周期时，保持 `ARCHITECTURE.md` 中的 main、preload、renderer 信任边界，并更新共享类型和 Electron 行为测试。
- 修改 UI 视觉、布局或交互时，遵循 `docs/UI_DESIGN.md` 的设计原则与交互不变量；修改 CDF、marker、统计展示、动画或导出时，同时保持 `ARCHITECTURE.md` 中的可视化与导出边界。
- 修改可视化输入时，按 `docs/ANALYSIS.md` 与 `docs/DISPLAY_CONFIG.md` 同步检查 Schema、校验、类型和相关测试。
- 修改 benchmark 时，优先覆盖完整批量模拟路径；跨 case 对比性能时注意不同配置的 `total_result` 可能不同。

## 容易忽略的行为

- `simulate_fixed_runs()` 用于固定 run 数场景，benchmark 默认使用它做小规模稳定测量。
- 对于不承诺长期存在或不承诺迁移的数据结构，不使用 `schema_version` 或者 `version` 等版本字段，例如 [IR](<docs/IR.md>) 和 [Analysis JSON](<docs/ANALYSIS.md>)。

## 提交信息

Commit message 遵循 [Conventional Commits](<https://www.conventionalcommits.org/en/v1.0.0/>)：

```text
<type>(<scope>): <简短描述>

[可选的详细说明]
```
