# Electron 素材导出计划

## 当前状态

截至 2026-09-10，路线验证及阶段 A、B、C1、C2、C3 均已完成开发、自动化验证和人工验收；阶段 D 已完成正式路线性能测量，后续继续完成阶段 D 的 analyzer 流式聚合与 Analysis 大小限制调整。

- Phase 0 选择 CDP 与阻塞式交互，历史依据见 [Windows 实验结果](docs/experiments/electron-export-phase0/README.md)。
- A–B 建立 Windows x64、固定源码 FFmpeg、材料收集及 CI/CD 基线。
- C1–C3 完成正式导出任务、桌面入口、安全提交、进度与取消、详细终态和可恢复清理。
- 中文及空格路径、屏幕阅读器交互已在 C2 验收；文件占用、清理恢复和退出残留已在 C3 验收。
- 阶段 D 的 21 个性能 run 全部有效；正式测量、环境和限制见 [阶段 D 报告](docs/experiments/electron-export-phase-d/README.md)。
- Remotion、实验内容和 FFmpeg 安装包分发边界尚未改变，由 D–E 处理。

## 稳定边界

桌面 renderer 只提交受限格式、基础文件名、会话标识和 reservation/task id。系统目录选择器由 main 以主窗口为 parent 打开；完整目录和目标路径不进入 desktop preload 契约、事件或错误文案。隐藏导出 renderer 只消费 CDF view model 与逐帧消息，不访问桌面 API、文件系统或子进程。

main 持有规范目录、目标路径和 `TargetIdentity`，在覆盖确认及每个产物提交前复核目标身份。每个格式独立使用同目录 partial/backup；目标替换成功即为提交点，已提交产物不因随后取消、另一格式失败或 backup 清理失败而回滚。

`ExportTaskCoordinator` 负责 reservation、快照、统一准入、唯一任务终态和最近一个合格任务的目录授权。`ExportHost` 负责隐藏窗口、CDP、FFmpeg、逐帧渲染、安全提交和可重试清理。清理失败时保留 task 与 admission，重试只处理仍持有的 FFmpeg、窗口、partial 或 backup；应用退出前仅对剩余失败资源再尝试一次，不循环重试。

桌面继续使用单一 `ExportWorkflow` 和根级 inert，不建立第二套导出 UI、通用全局交互协调器、通用错误码或更细的通用阶段状态机。所有异步返回和事件按 reservation/task id 及流程 generation 隔离；后台页面数据可以更新，但不得改变当前页面或焦点。

`src/visualize/` 只提供共享输入处理、CDF 场景、动画和宿主操作回调，不持有 session、文件名、目录或导出流程状态。

## 已完成阶段

### A–B. Windows 与 FFmpeg 基线

Windows 原生 Node/MSYS2 UCRT64、固定源码 FFmpeg、构建材料、隔离 PATH、CI/CD 和分发阻塞已经建立。检查命令见 [Development Checks](docs/DEVELOPMENT_CHECKS.md)，源码准备与材料职责见 [scripts README](scripts/README.md)，许可证和分发状态见 [FFmpeg 文档](docs/FFMPEG_DISTRIBUTION.md)。

### C1–C3. 正式入口与完整生命周期

- 建立共享任务契约、统一请求准入、ResultEditor 保存屏障和不可变快照；PNG、MP4 及双格式复用同一逐帧语义。
- 接通桌面入口、格式和 Windows 基础文件名校验、main-owned 目录选择、安全覆盖及目标身份复核。
- 提供准备、逐帧渲染、PNG 写入和逐产物提交进度；heartbeat 只刷新活动时间，阶段变化通过 `aria-live="polite"` 播报。
- 正式取消先确认，提交竞争按实际结果归类为完成、取消或部分成功失败；每个任务只发送一次终态。
- 终态只暴露格式、basename、脱敏错误和 `clean`/`blocked` 清理状态；成功与失败通知保持到关闭，纯取消通知短时显示。
- “打开所在文件夹”、清理重试和清理后退出均使用严格 `{ task_id }` IPC；renderer 不发送或接收路径。
- backup 删除属于 post-terminal cleanup。清理失败时阻塞壳不可通过 Esc、遮罩或导航绕过，可重复重试并在恢复后释放准入。

自动化覆盖共享契约、提交和取消竞争、部分成功、FFmpeg/窗口/partial/backup 清理、重试、过期事件隔离、双尺寸 Electron UI、截图场景及真实固定 FFmpeg ExportHost 集成。人工验收已覆盖 MP4、PNG、双格式、覆盖、中文及空格路径、取消、故障、文件占用、清理恢复、退出残留和屏幕阅读器。

## 后续阶段

### D. 性能复验

正式 Electron 导出路线已使用无逐帧探针的 production build 完成测量。每个场景预热一次、正式运行五次，并另行执行一次取消；21 个 run 全部有效，MP4/PNG 规格、事件时间线、内存采样和退出残留检查均通过。

实测摘要如下；耗时为五次正式运行的中位数，内存为同一采样时刻计算的工作集：

| 场景 | 总耗时 | preparing / rendering / finalizing | 最大事件间隔 | 定时器延迟 P95 | 最大工作集增量 | 最低系统可用内存 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 空闲 | 11,748.5 ms | 415.8 / 11,295.2 / 14.9 ms | 595.9 ms | 12.6 ms | 4,268.0 MiB | 42,144.4 MiB |
| 模拟中 | 19,360.8 ms | 982.1 / 18,361.5 / 17.2 ms | 989.5 ms | 12.5 ms | 4,420.7 MiB | 41,057.6 MiB |
| 分析中 | 12,269.3 ms | 442.8 / 11,794.4 / 16.5 ms | 902.3 ms | 12.2 ms | 8,193.2 MiB | 38,321.0 MiB |

取消请求到 renderer 收到 `cancelling` 的时间分别为空闲 0.9 ms、模拟中 0.7 ms、分析中 0.8 ms。模拟与分析正式 run 均实现 100% 重叠；没有活性契约违约、崩溃、超时、产物失败或资源残留。Phase 0 使用不同宿主、探针和 FFmpeg，只保留为背景，禁止计算严格回归比例。

下列后续关注项未执行，现明确废弃且不再作为 D、E 或发布的验收要求：

- 优化或继续测量 FFmpeg 约 3 GiB 的工作集占用；
- 在 8 GiB、16 GiB 或其它低内存环境执行稳定性、换页或 OOM 验证。

阶段 D 下一步只处理 analyzer 的大 GSR 内存占用与 Analysis 输出限制：

1. 将 analyzer 和 Electron `ResultEditor` 的 Analysis JSON 上限从 16 MiB 统一提高到 64 MiB；GSR v2 和 Analysis JSON 字段契约保持不变。
2. analyzer 顺序读取 GSR，使用哈希表聚合 result value 频数、使用定长 vector 聚合 termination reason 计数，再将唯一 result value 转为排序 vector 生成 CDF 和统计值；不保留逐 run 数组，不增加落盘归并。
3. 聚合期间根据唯一值计算最终 JSON 的最小可能大小；一旦该下界超过 64 MiB，立即拒绝。相关变量或函数附近必须注释该下界的含义、与哈希表内存无关，以及提前拒绝不会误伤仍可能装入 64 MiB 的输出。
4. 输出前对完整 Analysis JSON 执行精确的 64 MiB 序列化大小检查，覆盖 result item、termination reason、CDF 和统计字段；不得只依赖 Electron 接收 stdout 时的事后截断。
5. 以当前排序实现的既有语义作为等价基准，增加行为测试覆盖线性插值分位数、CDF 累计比例、termination largest-remainder、重复值、稀疏值、极端 `uint64_t` 值，以及最小大小下界和最终序列化大小在 64 MiB 限制附近的通过/拒绝边界。

### E. Remotion 移除

2. 确认 D 回归独立于 Spike 后删除实验入口、脚本、测试和探针样式，保留正式测试专用逐帧探针且禁止进入 production build。
3. 用单一归档文件替代 Phase 0 原报告目录，保留环境、版本/哈希、正确性、性能、故障清理和路线决策依据。
4. 删除 Remotion 导出宿主、相关依赖与传递打包产物，更新 lockfile、构建、CI 和文档。
5. 重新构建无探针 production build，复跑产物、连续帧和生命周期检查。

### F. 打包与许可证迁移

- 评估迁移到 GPL v3.0 and later 的明显阻塞项，并由维护者决定如何处理。
- 完成许可证决策与 FFmpeg 材料复核后，以 `extraResources` 将运行所需产物放在 ASAR 外；开发态和安装包分别使用固定资源路径。

### G. 验收与文档收尾

- 构建 Windows 安装包并进行本地验收，检查 MP4/PNG、覆盖、空格及中文路径、字体、视觉一致性和安装态资源稳定性；断网且无开发工具或 PATH 依赖时仍能导出。本阶段不发布 Release。
- 由维护者决定如何处理本分支引入的开发文档，若视为临时文档，应迁移重要信息后删除，若视为持久化文档，需明确文档长期职责。

## 文档维护

本文只维护稳定边界、完成摘要、证据入口和剩余决策。检查矩阵集中在 Development Checks，FFmpeg 构建命令集中在 scripts README，分发要求集中在 FFmpeg 专项文档。
