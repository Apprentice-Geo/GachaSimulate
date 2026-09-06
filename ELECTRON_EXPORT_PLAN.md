# Electron 素材导出计划

## 当前状态

截至 2026-09-06，路线验证与旧 Phase 1–3 内部宿主实现已完成；后续按本文 A–E 执行，不沿用历史阶段编号。

- Phase 0 选择 CDP 与阻塞式交互。原始响应门槛判定仍为 no-go，产品调整交互目标后决定继续；证据按需查阅 [Windows 实验结果](docs/experiments/electron-export-phase0/README.md)。
- 共享逐帧契约、独立导出页面/preload、内部 ExportHost、PNG/MP4、背压、取消、故障清理及 partial/backup 提交已落地。2026-08-28 Windows 本机单元、构建与真实宿主集成检查通过，不据此宣称远端 CI 或安装包已通过。
- 维护者已在 Windows 手动编译 FFmpeg 并验证脱离 MSYS2 后运行与编码；x264 源码构建、自动化和最终产物验收待完成，见 [FFmpeg 文档](docs/FFMPEG_DISTRIBUTION.md)。
- 桌面任务、IPC、用户入口和安装包接入尚未完成；Remotion 保留到新路径验收通过后移除。

## 固定范围与技术契约

第一版从当前 GSR 会话导出 MP4/PNG，只消费经过校验的 AnalysisV2 + DisplayConfig v2，复用 CDF view model、VisualizeScene 与共享动画。完成后移除全部 Remotion 实现与依赖，不额外下载或分发浏览器。

| 项目 | 固定契约 |
| --- | --- |
| 画布与时间线 | 3840×2160，60 FPS，确定性逐帧计算 |
| MP4 | 第 0–59 帧，共 60 帧；第 57–59 帧保持最终画面 |
| PNG | ANIMATION_COMPLETION_FRAME，当前第 57 帧 |
| 编码 | FFmpeg libx264，H.264、CRF 18、yuv420p，无音轨 |
| 画面 | render_mode="export"，不含操作栏或任务状态 |

不提供编码参数、尺寸、帧率或时长设置；不支持音频、透明视频、WebM、GIF、图片序列或硬件编码。

正式任务创建一个专用 offscreen BrowserWindow，加载独立 export.html 与 export preload，固定内容尺寸、device scale factor 1，关闭后台节流。它不复用桌面窗口或 capture:ui 的窗口；复用截图工具宿主方式的是 Phase 0 实验。

流程为：校验输入 → view model → 隐藏 renderer 提交指定帧 → CDP Page.captureScreenshot(PNG) → main 解码 → PNG 文件或 FFmpeg image2pipe。MP4 顺序写入并等待背压，不保存完整磁盘图片序列。

隐藏 renderer 初始化时等待字体和初始布局；每帧 React commit 后携带 job/frame id 返回 ready，main 验证发送方与标识后截图。commit 不是 Chromium paint 保证，不得用固定 sleep 替代协议；正式路径与 Electron 升级后保留独立像素检查。

## 任务与交互规则

### 请求准入与快照

- 导出位于 VisualizeShell 的 chart-actions，与重放、选择结果并列，保持 hover/focus-within；仅完整结果且可视化 ready 时可用。选择 MP4/PNG 后请求 main 保存对话框。
- main 接受请求时立即占用唯一导出名额，检查与占用之间不能异步等待。占用覆盖此前字段保存的完成、快照建立、保存对话框、正式执行及清理；准备失败或对话框取消时释放。
- 从占用起禁止新的用户任务请求，包括模拟、分析/GSR 选择、配置刷新/安装/更新/卸载和第二次导出。UI 禁用与 main 入口检查共同执行；状态读取、取消导出、系统关闭和退出继续允许。
- 已提交任务继续运行，其必要后续步骤、保存、提交和清理属于原任务，不受新请求限制；不能在每个内部步骤重新执行用户请求准入检查。
- 导出准备提交并等待当前展示字段保存完成，再从 ResultEditor 建立绑定结果会话与配置版本的不可变快照，之后打开保存对话框。此前提交的保存允许完成，占用后不接受新的用户编辑。
- 等待保存期间若会话已被后台分析替换，检测并中止本次准备，提示重新导出；不能把旧字段写到新会话或静默导出另一份结果。快照建立后，后台结果更新不得改变导出文件。
- 对话框取消不创建正式任务或进度遮罩，保留当前页面；已有后台任务状态照常更新。

### 并发与隔离

沿用现有进程边界：core 模拟、analyzer 分析、隐藏 renderer 渲染、FFmpeg 编码，main 异步协调。任务同时推进，导出内部保持逐帧顺序，不引入全局串行执行队列。

await 不能使同步计算并行。main 的 JSON 解析、校验、图像数据处理和同步文件操作仍可能延迟其它回调；隐藏 renderer 不隔离 Chromium browser/main 协调及 CPU/GPU/内存竞争。现有实验未定位各项延迟的具体占比。

后台状态正常记录；自动跳页、抢焦点、弹窗和完成提示延后至导出遮罩关闭。取消导出只停止导出，用户要取消后台任务须先结束导出。关闭窗口或退出则统一终止并等待所有相关任务与清理。

### 进度与结束行为

路径确认并创建正式任务后，显示全应用模态进度界面，背景导航、编辑、模拟、配置操作和图表控件全部 inert；焦点限制在状态区域和取消按钮。

共享契约包含 ExportFormat（mp4/png）、ExportStage（preparing/rendering/finalizing），以及 started、progress、heartbeat、cancelling、completed、failed、cancelled 事件。正常阶段按 preparing → rendering → finalizing → completed 推进；活动阶段可失败或进入 cancelling，取消以 cancelled 或清理失败的 failed 结束。事件携带任务标识，过期事件不能改变新任务 UI。对话框前的占用与正式任务状态分开表达。

- MP4 每帧确认并送入编码器后更新内部进度，UI 显示帧数与 0–100%；finalizing 保持帧数并显示正在封装，送完帧不代表文件已提交。PNG 只显示阶段。
- 从 preparing 到终态，相邻进度、阶段或状态心跳不超过 1 秒，包括 finalizing/cancelling。点击取消后 renderer 立即显示 cancelling，main 在 1 秒内确认接收；定时器本身不构成活性验证。
- 取消后保持遮罩直至子进程、隐藏窗口和临时文件清理完成。取消与输出提交竞争时，按实际提交结果返回唯一终态，不把已成功提交报告为取消。
- 成功后关闭遮罩并提示完成，提供“打开所在文件夹”；取消后提示已取消；失败后解除遮罩并保留错误。不自动重试，重新导出重新取得快照并确认路径。
- 清理失败应显示具体错误及残留信息；仍有活动资源时不能释放占用并允许下一次导出。

### 信任边界与文件生命周期

桌面 renderer 只提交受限格式枚举；preload 提供固定启动、取消与事件订阅。src/visualize/ 只接收宿主回调，不访问 Electron/Node。main 验证输入、取得权威快照、选择路径和编码器并负责资源；隐藏 renderer 开启 context isolation、关闭 Node integration，只接收 view model 与逐帧消息。

路径只来自 main 保存对话框，默认名称由快照对应 GSR stem 派生，覆盖须确认。先写目标目录唯一临时文件，再提交替换；失败或取消不得破坏原文件。宿主负责关闭 stdin、终止并等待 FFmpeg、销毁窗口、处理 partial/backup。打开所在文件夹由 main 依据已完成任务路径执行，不接受任意路径。

## 剩余执行步骤

### A. 固化 Windows 自编译

将 MSYS2 UCRT64 路线脚本化，固定源码，先构建 x264，再构建 FFmpeg/ffprobe；记录工具链、参数、补丁、依赖、哈希与材料。要求集中在 [FFmpeg 文档](docs/FFMPEG_DISTRIBUTION.md)，实现时确定精确版本。

完成条件：干净 Windows 环境可完整构建，产物脱离 MSYS2 开发环境可运行，具备项目编码与探测能力。

### B. 统一 Windows 开发基线与 CI

- 自编译产物替换 Gyan 准备流程，保持固定内部路径、无 PATH 回退；Windows 构建 job 产物直接供 Windows 导出集成检查消费。
- Windows 为唯一维护的开发、构建和运行测试基准。core/analyzer 与 x264/FFmpeg 统一采用 MSYS2 UCRT64 GCC；新增 Windows Debug/Release preset，移除 Linux preset 和 Linux CI job，不再维护 Linux 检查矩阵。
- 将 C++ Debug/Release CTest、原生流水线、Node 静态质量和测试、Electron 布局/行为/导出及安装包检查迁移到 Windows。Node/pnpm 使用 Windows 原生环境；验证所需运行依赖随产物正确提供，不因开发工具 PATH 掩盖缺失 DLL。
- 格式化继续使用 Windows UCRT64 中的 clang-format，沿用 `.clang-format`，本地与 CI 固定一致工具版本；使用 Clang 检查工具不改变 GCC 发布编译器。
- 静态分析优先保留 clang-tidy 与 `.clang-tidy`。Windows Ninja preset 生成本机 `compile_commands.json`，先验证 UCRT64 clang-tidy 能否正确消费 GCC 编译参数、宏和头文件路径，不复用 Linux 编译数据库。
- 若遇到 GCC 专属参数或头文件解析问题，先评估同一 UCRT64 环境中的 Clang 分析专用 preset，发布构建仍使用 GCC；只有实际兼容问题导致维护成本过高时才评估 Cppcheck，并记录规则覆盖与误报差异，不将 GCC 警告或 `-fanalyzer` 当作现有 C++ 静态检查的等价替代。
- 提供 Windows 本地与 CI 共用的格式化、静态分析入口，验证现有规则有效执行；工具初始化与日常命令集中记录在 Development Checks，不要求安装 WSL/Linux。
- 先验证完整构建，再优化缓存；缓存覆盖源码、工具链、配置和补丁变化，构建、测试及发布以产物哈希关联。
- 重跑共享契约、宿主单元与真实集成检查：PNG/MP4、连续帧、背压、故障、取消和退出清理；production build 不含像素探针。
- 同步准备命令、AGENTS.md、README、Development Checks、Git hook 和平台相关脚本；Remotion 移除前将其检查迁移到 Windows 并保留。

完成条件：Windows 本地和 CI 的完整检查矩阵通过，格式化与静态分析工具版本、配置及入口一致，Linux preset/job 已移除，开发流程可复现、产物可追溯。

### C. 接入正式任务、IPC 与 UI

按上述规则实现 ExportTask、共享类型、preload、main handler、新请求准入及 shutdown；接入操作栏、格式选择、保存对话框、模态进度和结果提示。可用自编译基线进行开发态产品接入，对外发布仍受 D 约束。

验证覆盖：

- 请求占用、重复点击、对话框取消、准备失败和释放；保存完成/失败、会话切换与快照隔离。
- 已有模拟/分析/配置任务及后续步骤继续完成，新用户请求被 main 拒绝，后台完成不抢焦点或跳页。
- 各阶段心跳、取消确认、唯一终态、提交竞争、清理失败与全任务退出协调。
- hover/键盘入口、禁用、inert、焦点限制与恢复、取消及结束提示。

完成条件：正式入口能导出，任务行为与真实 Electron UI 检查通过；响应问题依据测量定位，再决定是否调整 I/O、同步计算或进程隔离。

### D. 分发准备与安装包验收

- 完成 FFmpeg 材料复核后，以 extraResources 将运行所需产物放在 ASAR 外；开发态和安装包分别使用固定资源路径。
- 使用最终产物检查 Windows unpacked 与实际安装应用的 MP4/PNG、覆盖、空格/中文路径、字体和视觉一致性；断网且无开发工具/PATH 依赖时仍可导出，不下载浏览器。
- 正式任务独立覆盖连续帧像素识别、背压、进度/取消活性、renderer/编码器崩溃、退出及清理，不能仅用 ready frame id 证明截图正确。
- 测量空闲、已有模拟运行中、已有分析运行/完成时的导出；记录环境、后台负载、采样方法、总/阶段耗时、响应、Electron/FFmpeg/后台任务内存及系统稳定性。分别观测的峰值不直接相加为同时总峰值。
- 维护者依据正式报告记录允许继续、要求优化或更换路线。耗时和内存不设固定数值门槛，进度/取消活性要求仍适用；超时或系统无响应必须重新评估，不能以模态 UI 豁免。

完成条件：材料、真实安装包、断网检查和性能/内存评审通过；此前保留 Spike 与 Remotion。

### E. 清理迁移内容并复验

1. 确认 D 回归已独立于 Spike，删除 electron_export_spike* 脚本/测试、ExportSpikeApp、实验查询入口、探针样式及对应 scripts，重新构建安装包复验。保留正式测试专用逐帧探针，禁止进入 production build。
2. Spike 删后复验通过后，以单一人工归档替代 Phase 0 原报告目录；保留环境/命令、版本/哈希、正确性、聚合性能/响应/内存、故障清理、产物及原 no-go 到产品决定的依据，注明不再支持逐条复算并更新链接。本轮压缩不提前删除原始证据。
3. 删除 src/visualize/remotion/、旧导出宿主及无用辅助代码、全部 Remotion 直接依赖与传递打包产物；更新 lockfile、构建、导出命令和 CI，不降级为 devDependencies。
4. 删除后重新构建开发态与 Windows 安装包，复跑 MP4/PNG、连续帧、生命周期和断网检查；包内无 Remotion compositor、Remotion FFmpeg、额外浏览器或实验入口。
5. 更新 README、Architecture、Visualize Frontend Implementation 和 Development Checks，稳定契约留在专项维护文档。

完成条件：删后复验全部通过，Electron 自研导出成为唯一素材导出宿主；失败须修正并复验。

## 文档维护

本文只维护当前契约和剩余步骤；完成步骤压缩为状态及证据入口，不追加逐次日志、测试数量或源码清单。命令集中在 Development Checks，FFmpeg 要求只在专项文档维护，历史实验按需读取。
