# Electron 素材导出计划

## 当前状态

截至 2026-09-11，路线验证、阶段 A–D 以及阶段 E1–E2 均已完成。Phase 0 和阶段 D 的环境、正确性、性能及路线决策已集中到 [Electron 导出实验归档](docs/archived/ELECTRON_EXPORT_EXPERIMENTS.md)；未被消费的 heartbeat、Phase 0 Spike 和阶段 D 临时性能工具已经移除。

下一项是 E3：移除 Remotion 旧导出路径。当前仍保留 Remotion，不提前改变其命令、依赖或共享可视化契约。

## 稳定边界

桌面 renderer 只提交受限格式、基础文件名、会话标识和 reservation/task id。系统目录选择器由 main 以主窗口为 parent 打开；完整目录和目标路径不进入 desktop preload 契约、事件或错误文案。隐藏导出 renderer 只消费 CDF view model 与逐帧消息，不访问桌面 API、文件系统或子进程。

main 持有规范目录、目标路径和 `TargetIdentity`，在覆盖确认及每个产物提交前复核目标身份。每个格式独立使用同目录 partial/backup；目标替换成功即为提交点，已提交产物不因随后取消、另一格式失败或 backup 清理失败而回滚。

`ExportTaskCoordinator` 负责 reservation、快照、统一准入、进度、取消、唯一任务终态和最近一个合格任务的目录授权。`ExportHost` 负责隐藏窗口、CDP、FFmpeg、逐帧渲染、安全提交和可重试清理。清理失败时保留 task 与 admission，重试只处理仍持有的 FFmpeg、窗口、partial 或 backup；应用退出前仅对剩余失败资源再尝试一次，不循环重试。

桌面继续使用单一 `ExportWorkflow` 和根级 inert，不建立第二套导出 UI 或通用全局交互协调器。所有异步返回和事件按 reservation/task id 及流程 generation 隔离；后台页面数据可以更新，但不得改变当前页面或焦点。ExportHost 每次 renderer 请求继续使用 30 秒协议超时。

`src/visualize/` 只提供共享输入处理、CDF 场景、动画和宿主操作回调，不持有 session、文件名、目录或导出流程状态。正式逐帧集成检查继续使用 `__GACHASIMULATE_EXPORT_FRAME_PROBE__`，普通 production build 不得包含该探针。

## 已完成阶段

### A–B. Windows 与 FFmpeg 基线

建立 Windows x64 原生开发基准、固定源码 FFmpeg、构建材料与哈希记录、隔离 PATH、CI/CD 检查和安装包分发阻塞。检查命令见 [Development Checks](docs/DEVELOPMENT_CHECKS.md)，源码准备职责见 [scripts README](scripts/README.md)，许可证和分发状态见 [FFmpeg 文档](docs/FFMPEG_DISTRIBUTION.md)。

### C1–C3. 正式入口与完整生命周期

完成共享任务契约、统一准入、不可变快照、桌面导出入口、格式与文件名校验、main-owned 目录选择、安全覆盖、逐帧进度、取消竞争、部分成功终态和可恢复清理。自动化与人工验收覆盖 MP4/PNG/双格式、中文及空格路径、覆盖、故障、文件占用、退出残留和辅助技术交互。

### D. 性能复验与 analyzer 内存边界

正式 CDP + 固定源码 FFmpeg 路线完成两轮完整矩阵；流式 analyzer 在 10 亿 runs、12.00 GB GSR 上将峰值工作集降至 13.6 MiB，并提升约 39% 吞吐。三轮实验的可比限制、完整环境与关键数据见 [实验归档](docs/archived/ELECTRON_EXPORT_EXPERIMENTS.md)。

### E1–E2. 实验归档与迁移期清理

将 Phase 0 和阶段 D 的长期结论归档为单一文档，删除已跟踪原始实验目录、Spike route/harness/metrics、临时性能 runner 及脚本入口。删除没有 watchdog 消费方的导出 heartbeat 契约与定时器；保留 progress、cancelling、terminal、30 秒 renderer 协议超时、正式 ExportHost 集成 harness 和 CI 探针防线。

## 后续阶段

### E3. Remotion 移除

- 删除 Remotion 导出宿主、相关依赖与传递打包产物，更新 lockfile、构建、CI 和文档。
- 保持 `Analysis + DisplayConfig`、共享场景、动画与 Electron 逐帧语义不变。

### E4. 无 Remotion 路线复验

- 重新构建无探针 production build，确认不含逐帧测试标记。
- 复跑正式 ExportHost 产物、连续帧和生命周期集成检查。

### F. 打包与许可证迁移

- 评估迁移到 GPL v3.0 and later 的明显阻塞项，并由维护者决定如何处理。
- 完成许可证决策与 FFmpeg 材料复核后，以 `extraResources` 将运行所需产物放在 ASAR 外；开发态和安装包分别使用固定资源路径。

### G. 验收与文档收尾

- 构建 Windows 安装包并本地验收 MP4/PNG、覆盖、中文及空格路径、字体、视觉一致性和安装态资源稳定性；断网且无开发工具或 PATH 依赖时仍能导出。本阶段不发布 Release。
- 由维护者决定本分支开发文档的长期职责，并迁移或删除临时内容。

## 文档维护

本文只维护稳定边界、完成摘要、证据入口和剩余决策。检查矩阵集中在 Development Checks，FFmpeg 构建命令集中在 scripts README，分发要求集中在 FFmpeg 专项文档。
