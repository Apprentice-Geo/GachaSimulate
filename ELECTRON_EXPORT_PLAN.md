# Electron 素材导出计划

## 当前状态

截至 2026-09-09，路线验证、内部 ExportHost 及阶段 A、B、C1、C2 已完成开发与自动化验证；C2 仍待人工产品验收。后续从 C3 继续，不沿用历史阶段编号。

- Phase 0 选择 CDP 与阻塞式交互；原始响应门槛为 no-go，产品调整交互目标后决定继续。历史依据见 [Windows 实验结果](docs/experiments/electron-export-phase0/README.md)。
- 固定源码 FFmpeg 构建及 Windows x64 开发、CI/CD 基线已经验收。命令与证据入口见 [Development Checks](docs/DEVELOPMENT_CHECKS.md)、[scripts README](scripts/README.md) 和 [FFmpeg 文档](docs/FFMPEG_DISTRIBUTION.md)。
- C1 建立正式任务、统一准入、结果快照、隐藏 renderer、CDP/FFmpeg 逐帧导出和逐产物提交。
- C2 接通桌面入口、格式与文件名、main-owned 目录选择、安全覆盖和最小阻塞交互；单元、真实 Electron UI、production/probe build 及真实自编译 FFmpeg ExportHost 集成均通过。
- Remotion、Spike 与安装包分发边界尚未改变；详细进度、清理恢复和跨任务提示协调留给 C3。

## 稳定边界

桌面 renderer 只提交受限格式集合、基础文件名、会话标识和 reservation/task id。目录由 main 以主窗口为 parent 打开系统选择器取得，完整路径不进入 preload 契约、桌面事件或错误文案。隐藏导出 renderer 只消费 CDF view model 与逐帧消息，不访问桌面 API、文件系统或子进程。

main 在 reservation 内保存规范目录、目标路径和 `TargetIdentity`。已存在目标只接受非链接普通文件，身份包含 bigint `dev`、`ino`、`size`、`mtimeNs` 与 `ctimeNs`；覆盖确认前和每个产物提交前必须复核。每个格式独立以同目录 partial/backup 完成提交，一个已提交产物不因另一格式随后失败而回滚。

`src/visualize/` 只提供共享输入处理、CDF 场景、动画与宿主操作回调，不持有 session、文件名、目录或导出状态机。桌面 renderer 的单一流程覆盖 `closed → editing → preparing → choosing_destination → confirming_overwrite → handing_off → started`，提交前可进入 `cancelling`；所有异步返回与事件按 reservation/task id 隔离。

阶段 C2 的 started 状态只提供任务摘要、全应用 inert/焦点限制和取消。成功、取消或失败只显示通用通知，不展示逐帧进度、部分成功详情或 post-terminal cleanup；这些行为由 C3 直接扩展现有状态机。

## 已完成阶段与证据

### A–B. Windows 与 FFmpeg 基线

Windows x64 原生 Node/MSYS2 UCRT64、固定源码 FFmpeg、构建材料、隔离 PATH、CI/CD 和分发阻塞已经建立。检查命令只在 [Development Checks](docs/DEVELOPMENT_CHECKS.md) 维护，源码准备和材料职责只在 [scripts README](scripts/README.md) 维护，许可证与分发状态只在 [FFmpeg 文档](docs/FFMPEG_DISTRIBUTION.md) 维护。

### C1. 正式导出底座

共享任务契约、desktop preload/main handler、统一用户请求准入、ResultEditor 保存屏障和不可变快照已经完成。`ExportHost` 支持 PNG、MP4 和双格式共享第 57 帧、FFmpeg 背压、进度/心跳/取消、逐产物 partial/backup/提交以及统一资源清理；真实 Electron 与自编译 FFmpeg 集成覆盖连续帧、编码器/renderer 故障和退出。

### C2. 桌面入口与安全目标提交

已完成：

- `chart-actions` 固定加入“导出素材”，保留 hover/focus-within 行为；缺少结果、非 ready 或已有流程时保留占位并提供辅助技术可读原因。
- 格式对话框默认 MP4+PNG，基础文件名来自 GSR filename stem；共享校验拒绝空值、Windows 非法/保留/尾随名称和超长组件，main 继续检查规范完整路径与目录边界。
- 新增只携带 reservation id 的目录选择和覆盖确认 IPC；main 保存主窗口引用、校验发送方并作为系统选择器 parent，renderer 不提交或接收路径。
- 系统取消和覆盖返回以 `destination-returned` 释放 reservation，保留用户输入回到格式框；普通取消使用 `cancelled`。
- `start_reserved_task()` 更名为 `commit_reservation()`，目标复核后同步完成 reservation 到 task 的 admission handoff。
- 目标选择、覆盖确认和每个产物提交均执行文件身份检查；创建、删除、原位修改、替换、目录或链接目标安全失败，双格式允许前一产物已提交而后一产物因竞争失败。
- started 后使用 C2 最小全应用阻塞壳，终态解除并显示通用通知；模态框支持初始焦点、Tab 循环、Esc/关闭、背景 inert、遮罩不可关闭与入口焦点恢复。

自动化证据入口是 `test:electron-export`、`test:electron-layout`、三个 `capture:ui` 导出场景，以及 [Windows x64 Electron 导出检查](docs/DEVELOPMENT_CHECKS.md#windows-x64-electron-导出检查)。C2 状态记录为“开发及自动化验证完成，待人工验收”。

### 人工验收问题报告

- 导出时出现：[vite] (client) Pre-transform error: Failed to load url /export-renderer/main.tsx (resolved id: /export-renderer/main.tsx). Does the file exist? 最后导出超时取消，该bug影响验收
- 上一轮修改导致了UI契约偏移，新的UI无法填满窗口，新截图已经进入 tmp\ui-captures，同样需要排查问题
- 导出的选择格式对话框每次状态更改都会导致背景统计图触发重绘制，预期行为是只有导入新结果或点击重绘按钮才触发重绘制

### 人工验收问题修复计划

以下项目依次对应上方三个问题；全部完成并重新通过相关自动化与真实 Windows 窗口验收后，C2 才可视为完成人工验收。

1. （已完成）修复开发态隐藏导出 renderer 入口。保留 `src/export-renderer/` 的实现边界，在 electron-vite renderer root 内增加薄入口模块，由 `export.html` 通过 root 内相对路径加载，再由该模块导入正式导出 renderer。不得依赖 Vite 私有 `/@fs/` URL。新增开发服务器模式 smoke test，至少验证隐藏 renderer 能完成 `initialized` 握手并开始首帧请求；继续保留 production build 与真实 FFmpeg ExportHost 集成验证。
2. （已完成）恢复桌面 UI 的全窗口布局契约。保留承载 `inert` 的 `export-background` 包装层，为其补齐横向 flex 扩展、`width: 100%` 和 `min-width: 0`，使内部 `renderer-shell` 以完整宿主宽度布局。扩展 Electron 布局测试，在 1280×720 与 2560×1440 下分别断言 `root`、`export-background` 和 `renderer-shell` 的可用矩形一致，并覆盖导出对话框打开与关闭状态；重新生成并人工检查全部 UI 截图，不再只以截图像素尺寸作为通过依据。
3. （已完成）阻止导出流程状态触发可视化重绘。由桌面 `App` 按当前 `Analysis` 与 `DisplayConfig` 引用缓存 CDF view model，render-prop 只向可视化层传递稳定输入；导出 context 可同步稳定化，但不得把 session、reservation 或任务状态下沉到 `src/visualize/`。新增回归测试：动画进入 idle 后，打开对话框、切换格式、修改文件名以及切换导出 phase 均不得重新播放；导入新结果和点击重绘按钮仍必须启动动画。

C2 阶段人工验收已完成。

## 后续阶段

### C3. 完成进度、终态、清理恢复与交互协调

直接扩展 C2 状态机和阻塞壳，不建立第二套导出 UI。

#### 进度与取消

- 显示格式相关准备、逐帧渲染、PNG 写入和最终提交阶段；消费 C1 的 progress/heartbeat，提供可访问 live region，心跳不改写有意义的阶段文案。
- 正式任务取消增加确认；确认后保持全应用阻塞，按钮禁用并显示正在取消。取消与输出提交竞争以实际提交结果产生唯一任务终态，不把已成功提交产物改报为未保存。
- 所有事件继续先校验 reservation/task id；迟到进度、心跳、取消响应和旧终态不能关闭或改写新流程。

#### 终态与部分成功

- 桌面终态只返回格式与 basename 摘要，明确区分已保存、失败和残留产物，不暴露目录或完整路径。
- 成功显示可关闭的“导出完成”通知；取消显示短时通知；失败显示持久、可执行的原因。一个产物成功而另一个失败时列出已保存与失败格式，不回滚已提交文件。
- main 保存受限的最近任务输出目录映射；“打开所在文件夹”只提交 `task_id`，renderer 不提交路径。映射仅覆盖允许打开的最近任务，并在生命周期结束时受控清理。

#### Post-terminal cleanup

- 清理失败且仍有活动资源时，main 保留 task 与 admission 所有权，UI 继续全应用阻塞并展示残留 basename、具体错误、“重试清理”和“退出应用”。
- 新增只携带 `task_id` 的清理重试 IPC。重试期间按钮禁用；失败更新 cleanup 状态，成功释放占用并关闭阻塞壳，但不发送第二个任务终态。
- 清理成功后的通知区分“文件已保存，导出资源现已清理”和“导出失败，导出资源现已清理”；随后才允许下一次导出。
- backup 删除属于提交后清理。清理失败不能通过 Esc、关闭按钮、遮罩或导航绕过。

#### 全应用交互协调

- 根级交互协调器覆盖完整导出交互期，延迟后台弹窗、完成提示、跳页和抢焦点行为；后台任务数据仍可更新。
- 导出退出后先显示导出终态，再按 FIFO 恢复延迟提示。已经失去上下文的跳页或抢焦点请求降级为非模态通知，不破坏当前页面与焦点。
- 应用退出先协调正式任务取消与 post-terminal cleanup；仍有无法释放资源时保持明确阻塞，不静默退出。

#### C3 验证矩阵

- MP4、PNG、双格式的阶段文案、逐帧进度、心跳、live region、取消确认、唯一终态及过期事件隔离。
- 提交前/提交中竞争、renderer/编码器故障、普通清理失败、cleanup 重试成功/失败和退出协调。
- 部分成功时已保存/失败/残留 basename 展示与打开目录授权；任何 renderer 请求均不携带路径。
- 背景 inert、焦点限制、不可绕过清理、通知保留期，以及后台提示 FIFO 恢复和抢焦点降级。
- 真实 Windows 窗口中完成 MP4、PNG、双格式、覆盖、中文/空格路径、取消、失败、清理恢复和屏幕阅读器验收。

完成条件：正式入口具备可信的进度、取消、部分成功、清理恢复与全应用协调，真实 Electron UI 和自编译 FFmpeg 产品验收通过。对外发布仍受 D 约束。

### D. 分发准备与安装包验收

- 完成 FFmpeg 材料复核后，以 `extraResources` 将运行所需产物放在 ASAR 外；开发态和安装包分别使用固定资源路径。
- 使用最终安装产物检查 MP4/PNG、覆盖、空格/中文路径、字体和视觉一致性；断网且无开发工具/PATH 依赖时仍可导出，不下载浏览器。
- 测量空闲、模拟运行中、分析运行/完成时的耗时、响应、Electron/FFmpeg/后台任务内存与系统稳定性。维护者依据正式报告决定继续、优化或更换路线。

完成条件：材料、真实安装包、断网检查和性能/内存评审通过；此前保留 Spike 与 Remotion。

### E. 清理迁移内容并复验

1. 确认 D 回归独立于 Spike 后删除实验入口、脚本、测试和探针样式，保留正式测试专用逐帧探针且禁止进入 production build。
2. 用单一人工归档替代 Phase 0 原报告目录，保留环境、版本/哈希、正确性、性能/响应/内存、故障清理和路线决策依据。
3. 删除 Remotion 导出宿主、相关依赖与传递打包产物，更新 lockfile、构建、CI 和文档。
4. 重新构建开发态与 Windows 安装包，复跑产物、连续帧、生命周期、断网检查，并确认包内无额外 compositor、FFmpeg 或浏览器。

### F. 许可证迁移

评估迁移到 GPL v3.0 and later 的可行性。

## 文档维护

本文只维护稳定边界、完成摘要、证据入口和剩余决策；不追加逐次日志、测试数量或源码清单。检查矩阵集中在 Development Checks，FFmpeg 构建命令集中在 scripts README，分发要求集中在 FFmpeg 专项文档。
