# Electron 素材导出计划

## 状态

本文档记录 Electron 自研素材导出的实施计划。计划完成并通过开发态与安装包验证后，项目将移除 Remotion 导出实现及全部 Remotion 依赖，不在正式运行时或开发依赖中继续保留 Remotion。

Windows Phase 0 已于 2026-08-27 完成。`capturePage()` 没有通过同步正确性门槛；CDP 在 Phase 0 fixture、固定 Electron 和本次 Windows 环境中通过逐帧正确性与吞吐门槛，但 main 与普通 renderer 响应延迟超过实验前预设门槛，因此原始实验结论为 **no-go**。产品评审随后确认导出采用阻塞式进度界面，导出期间不承诺其它交互的低延迟，并选择 CDP 作为唯一正式截图路线；正式 `ExportTask`、安装包和升级后的正确性仍按后续阶段复验。这是对用户交互目标和生产验收口径的调整，不追溯修改原始实验判定。原始数据和结论见 [Phase 0 Windows 结果](docs/experiments/electron-export-phase0/README.md)。

## 目标

- Electron 从当前 GSR 结果会话导出 MP4 动画或 PNG 静态图。
- 复用 Electron 已携带的 Chromium，不额外下载或分发 Chrome、Chromium 或 Chrome Headless Shell。
- Electron 展示与导出继续共用 `AnalysisV2 + DisplayConfig v2`、CDF view model、`VisualizeScene` 和逐帧动画语义。
- 导出任务具备进度、取消、失败清理和应用退出清理。
- 新导出能力验证完成后，删除 Remotion 实现、脚本、依赖和相关维护边界。

## 非目标

- 不提供分辨率、帧率、码率、CRF、编码器或动画时长配置。
- 不支持音频、透明视频、WebM、GIF 或图片序列。
- 不从当前可见窗口直接截图，不让 renderer 选择可执行文件或传入任意输出路径。
- 不在第一版引入 GPU 共享纹理、平台相关原始位图快速路径或硬件编码。

## 已确认决策

### 输出规格

- 固定画布为 3840×2160。
- 固定帧率为 60 FPS。
- MP4 导出第 0～59 帧，总计 60 帧；第 57 帧进入完成状态，第 57～59 帧保持相同最终画面。
- PNG 导出 `ANIMATION_COMPLETION_FRAME` 的完整状态，当前值为第 57 帧。
- MP4 使用 `libx264` 编码 H.264、CRF 18、`yuv420p`，不包含音轨；第一版不比较或切换其它 H.264 encoder。

动画帧必须由共享时间线确定性计算。导出宿主不得运行基于真实时钟的动画，也不得依赖导出机器能否实时达到 60 FPS。

### 用户入口

导出按钮放入可视化页面现有的隐藏操作栏，即 `VisualizeShell` 中包含“重放动画”和“选择结果”按钮的 `chart-actions` 区域。

- 操作栏继续在图表区域 hover 或 focus-within 时显示。
- 新增一个“导出”按钮，与“重放动画”和“选择结果”并列。
- 点击“导出”后选择“MP4 视频”或“PNG 图片”，再由 main 打开对应的保存对话框。
- 导出画面使用 `show_controls={false}`，隐藏操作栏本身不得出现在导出文件中。
- `src/visualize/` 只接收宿主提供的导出回调，不直接调用 Electron IPC，保持平台无关。

### 导出期间交互

- main 完成保存对话框并正式启动任务后，renderer 显示覆盖整个应用窗口的模态进度界面；导出结束、失败或取消前不自动关闭。
- 模态界面使导航、结果编辑、GSR 选择、模拟与配置仓库操作、重放和第二次导出请求全部 inert；焦点限制在导出状态区域和“取消导出”按钮内。
- MP4 显示阶段、已送入编码器的帧数和 0～100% 进度条；finalizing 阶段保持已完成帧数并明确显示正在封装。PNG 只显示 preparing、rendering、finalizing 阶段，不伪造逐帧百分比。
- “取消导出”是任务期间唯一的应用内操作。点击后 renderer 立即显示 cancelling 并保持遮罩，main 必须在 1 秒内确认已收到取消请求；遮罩持续到 main 确认 FFmpeg、隐藏 renderer 和临时文件已经清理。
- 导出期间允许普通页面动画与其它交互出现延迟，不再以普通窗口 P95 100 ms 作为路线硬门槛；从 preparing 开始到 completed、failed 或 cancelled 结束，至少每 1 秒产生一次进度、阶段或状态心跳，包括没有新帧的 finalizing 和 cancelling。
- 系统关闭窗口和应用退出继续进入统一 shutdown 流程，不能被 inert 状态屏蔽。

## Phase 0 证据与实验后选定路线

Phase 0 复用了截图检查已有的 offscreen BrowserWindow 作为实验宿主，并在同一宿主上比较两个后端。`capturePage()` 在所有候选边界中都出现旧帧或终态不一致；产品评审据此决定正式实现只保留 CDP `Page.captureScreenshot(PNG)`：

```text
AnalysisV2 + DisplayConfig
        -> validate
        -> build_cdf_view_model
        -> offscreen BrowserWindow / VisualizeScene(frame)
        -> CDP Page.captureScreenshot(PNG)
        -> base64 decode
        -> PNG file or FFmpeg image2pipe
        -> PNG / MP4
```

正式导出任务创建一个专用 `offscreen: true` BrowserWindow，不复用开发截图脚本中的窗口，也不再创建第二个导出窗口。该窗口固定使用 3840×2160 内容尺寸、device scale factor 1，并禁用后台节流。导出页面不挂载交互用 `VisualizeApp`，而是接收明确的 CDF view model 和 frame，按下式构造共享动画进度：

```text
elapsed_ms = min(frame, ANIMATION_COMPLETION_FRAME) / VIDEO_FPS * 1000
```

Phase 0 中 CDP 在 commit、fonts、单 RAF 和双 RAF 的 12 组完整序列中均为零错帧，commit 是该 fixture 中额外等待最少的可靠边界。产品据此选择“React commit 后携带 job id 与 frame id 返回 ready，再由 CDP 截图”的正式时序；它不是 React commit 自身提供的 Chromium paint 保证，因此正式路径和 Electron 升级后仍保留连续帧像素检查。导出 renderer 初始化时另行等待 `document.fonts.ready` 和初始布局。

CDP 产生 PNG 帧。MP4 将连续 PNG 写入 FFmpeg `image2pipe`，避免在磁盘保存完整图片序列。本次 Windows 实验环境和代表性 FFmpeg build 测得 60 帧截图中位 13.08 秒、包含 FFmpeg 中位 16.80 秒；产品接受约 17 秒作为阻塞式导出的实验基线，但它不是其它机器或正式安装包的性能承诺。实验响应探针只说明共享资源竞争会造成调度延迟，不能代替正式主窗口进度与取消活性检查。

正式实现将 FFmpeg 可执行文件随 Windows 安装包分发，通过 `extraResources` 放在 ASAR 外。main 只解析应用内受信任的 FFmpeg 路径，不接受 renderer 提供可执行文件路径或命令行参数。

项目可以接受分发包含 `libx264` 等 GPL 组件的 FFmpeg build，第一版固定使用 `libx264`。FFmpeg 作为独立可执行文件由子进程调用是架构决策，不据此预设项目许可结论；正式发布前仍须核对最终 build 的组件组合以及对项目许可、声明、对应源码、构建配置与修改记录的具体义务。

## Phase 0 实验代码与产物生命周期

Phase 0 代码只用于验证路线，不构成正式导出 API。正式实现不得从 Spike 文件导入任务协议或运行时逻辑，也不得长期并存两套导出 renderer。它们在正式路径完成前承担实现参考和回归基线作用，后续按下表处理：

| 文件或入口                                                                                            | 当前作用                                                                       | 后续处理                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `src/dev/electron_export_spike.ts`                                                                    | 编排 `capturePage()`/CDP 对比、FFmpeg 管道与背压、性能采样、故障注入和清理验证 | 保留到 Phase 6 删除前门槛通过；将仍适用的场景迁移为针对正式 `ExportTask` 的集成检查，不作为生产代码依赖   |
| `src/dev/electron_export_spike_metrics.ts`、`src/dev/electron_export_spike_metrics.test.ts`           | 按实验前门槛汇总并自动选择候选后端                                             | 保留原始实验判定的可解释性；正式验收不复用已经改变的响应门槛，通过 Phase 6 删除前门槛后删除               |
| `src/renderer/ExportSpikeApp.tsx`                                                                     | 使用固定 fixture 渲染共享场景，暴露逐帧 barrier 和像素 frame-id 探针           | Phase 2 建立正式导出 renderer 时仅作为协议参考；保留到 Phase 6 删除前门槛通过，避免迁移期间失去像素级对照 |
| `src/renderer/main.tsx` 中的 `electron-export-spike` 查询分支、`src/renderer/styles.css` 中的探针样式 | 将实验页面接入现有 renderer 构建并提供机器可读像素探针                         | 与 `ExportSpikeApp.tsx` 按同一门槛删除；清理后的正式应用和安装包不得保留实验查询入口                      |
| `package.json` 中的 `spike:electron-export`、`test:electron-export-spike`                             | 运行完整实验和实验指标单元测试                                                 | 通过 Phase 6 删除前门槛后删除；长期检查应直接覆盖正式导出路径                                             |
| `docs/experiments/electron-export-phase0/windows-2026-08-27.json`、同目录 `README.md`                 | 保存逐次原始测量、环境信息、汇总结论和实验后产品决策                           | 保留到 Phase 6 Spike 删后复验通过；随后由单一归档文档（人工编写）替代并删除原目录                         |

归档文档至少保留实验环境和命令、Electron 与 FFmpeg 版本及校验信息、正确性结论、聚合耗时与响应指标、内存峰值、故障清理结论、代表性产物规格与校验值，以及“原门槛 no-go、产品改用阻塞式交互后选择 CDP”的决策过程。归档时同步更新本文档中的实验结果链接。

删除原始 JSON 意味着不能再从仓库内逐条复算各序列和百分位；归档文档只承担决策追溯与基线记录。

Phase 0 运行时代码的删除前门槛是：正式路径能够独立运行连续帧像素正确性、进度/取消活性、FFmpeg 背压、隐藏 renderer 与编码器崩溃、应用退出和临时文件清理检查，正式 MP4/PNG 已通过产物检查，并且正式耗时与内存报告已经由项目维护者人工评审并获准继续。满足这些条件后删除上述 Spike 代码、入口和 scripts，再重新构建安装包完成删后复验。删后复验失败时清理尚未完成，必须修正并重新验证；通过后才能归档 Phase 0 产物。

## 进程与信任边界

### Renderer

- 展示导出入口、格式选择、进度、取消和结果消息。
- 导出前提交并等待当前展示字段保存完成，避免导出未保存或旧版本的 DisplayConfig。
- 只提交受限的格式枚举，不提交任意文件路径、FFmpeg 参数或分析数据。

### Preload

- 暴露固定的 `startExport(format)`、`cancelExport()` 和导出事件订阅接口。
- 不暴露通用 IPC、文件系统、BrowserWindow 或子进程能力。

### Main

- 从 `ResultEditor` 取得已校验的 AnalysisV2 和 DisplayConfig 不可变快照。
- 构建 CDF view model，弹出保存对话框并决定最终路径。
- 管理专用 offscreen BrowserWindow、逐帧握手、截图、FFmpeg、进度和取消。
- 验证 IPC 输入、限制单一活动导出任务，并负责所有临时文件清理。

### 隐藏导出 Renderer

- 开启 context isolation，关闭 Node integration，只加载本地可信资源。
- 接收已构建的 CDF view model 和目标 frame。
- 初始化时等待 `document.fonts.ready` 和初始布局；每次 React 提交目标帧后，携带 job id 与 frame id 返回 ready 确认。
- 不访问文件系统，不启动 FFmpeg，不决定输出路径。

## 导出任务模型

共享类型定义至少包含：

```text
ExportFormat = "mp4" | "png"
ExportStage = "preparing" | "rendering" | "finalizing"
ExportEvent = started | progress | heartbeat | cancelling | completed | failed | cancelled
```

任务状态转换为：

```text
idle
  -> preparing
  -> rendering
  -> finalizing
  -> completed
preparing | rendering | finalizing
  -> failed
preparing | rendering | finalizing
  -> cancelling
  -> cancelled | failed
```

同一时间最多允许一个导出任务。开始后使用不可变结果快照；用户随后编辑字段或切换页面不得改变正在生成的文件。

MP4 进度以已确认并送入编码器的帧数为主，至少每完成一帧发布一次内部进度；renderer 可合并显示更新。整个活动任务期间相邻进度、阶段或状态心跳不得超过 1 秒，finalizing 和 cancelling 没有新帧时也须发送状态心跳。finalizing 阶段等待 FFmpeg 完成编码和封装。PNG 在准备完成后导出一帧，使用阶段状态而不伪造细粒度百分比。

保存对话框取消时保持原页面且不创建任务；保存路径确认并创建任务后立即进入阻塞式进度界面。任务期间拒绝第二次导出请求，取消后保持 cancelling 直到清理完成。失败重试、完成提示和是否提供“打开文件夹”仍须在固定正式 IPC 事件语义前完成设计。

## 文件安全与生命周期

- 保存路径只能来自 main 的原生保存对话框。
- 默认文件名由当前 GSR 文件 stem 派生，并按格式添加 `.mp4` 或 `.png`。
- 导出先写入目标目录中的唯一临时文件，成功后再替换最终文件。
- 失败、取消或应用退出时关闭 stdin、终止并等待 FFmpeg、销毁隐藏窗口并删除临时文件。
- 应用关闭时将导出任务纳入现有 shutdown 流程；不得留下孤儿进程或半成品输出。
- 覆盖已有文件必须经过保存对话框确认，失败时不得破坏原文件。

## 实施阶段

### 0. 验证技术路线

Phase 0 已完成并保留以下 Spike 与原始数据，不包含正式 IPC 或产品 UI。

- 建立最小本地导出页面和 offscreen BrowserWindow，使用固定 3840×2160、device scale factor 1、禁用后台节流的同一实验宿主。
- 实现 `capturePage({ stayHidden: true }) -> toPNG()` 与 `Page.captureScreenshot(PNG) -> base64 decode` 两个候选后端；使用项目固定 Electron 版本及其内置 CDP，不依赖外部 Chrome。
- 使用专用同步探针让每帧携带可机器读取的 frame id，连续验证 60 帧无旧帧、错帧或意外重复；生产场景第 57～59 帧按契约允许相同。
- 对比 React commit、字体就绪、单 RAF 和双 RAF 等候选边界，确认在 Phase 0 fixture 中 `setFrame -> commit ready -> CDP screenshot` 的可靠时序，不使用固定 sleep。
- 对两个截图后端分别运行“截图到内存”和“截图后写入真实 FFmpeg”两类实验，避免编码吞吐掩盖截图后端差异。Spike 可以使用来源、版本、编码器和构建信息均有记录的代表性 FFmpeg build；Phase 1 选定最终分发 build 后，必须用该 build 复测受影响的吞吐、背压和生命周期指标。
- 分阶段记录 `setFrame -> ready`、截图返回、`toPNG()` 或 base64 decode、stdin 写入与 drain、FFmpeg finalizing；同时记录 60 帧总时间、单帧平均与 P95、main event-loop 最大延迟、主窗口响应探针以及 Electron 与 FFmpeg 进程树峰值内存。
- 在正式测量前完成预热，按固定次数重复实验。实验开始前记录正确性硬门槛、可接受的绝对耗时与 UI 延迟，以及切换后端所需的最小重复性收益，避免看到结果后再定义成功标准。
- 验证 FFmpeg stdin `write() === false -> drain`、取消、编码器崩溃、隐藏 renderer 崩溃和应用退出；确认任务停止生产帧、关闭管道、终止并等待子进程且不遗留半成品。
- 已形成 Spike 结果记录；产品评审基于阻塞式导出交互选择 CDP 与 commit 边界继续实施，同时保留响应延迟和内存峰值为生产风险。

### 1. 固化共享逐帧契约与 FFmpeg 基线

- 将当前位于 Remotion 目录中的 frame state 计算迁移到平台无关的动画模块。
- 保持第 0～59 帧、第 57 帧完成及 57～59 帧最终状态一致的测试。
- 保证 `VisualizeScene` 的导出模式不包含控件，也不依赖真实时钟、CSS 动画或宿主缩放。
- 在实现正式 MP4 路径前，确定 Windows FFmpeg build 的来源、版本、校验值和构建配置，确认启用 `libx264`，并确定许可证文本、对应源码、修改记录和构建信息的分发方式。新增其它安装包目标时另行完成对应平台的同类工作。

### 2. 建立导出 Renderer

- 为 Electron 构建增加专用本地导出页面入口。
- 渲染固定尺寸的 `VisualizeScene`，复用共享 CSS、字体和 CDF view model。
- 定义初始化、设置 frame、frame ready 和错误消息协议。
- 在首次截图前等待字体和初始布局完成；每帧截图前验证返回的 job id 与 frame id。

### 3. 建立截图与 FFmpeg 宿主

- 实现专用 `offscreen: true` BrowserWindow 的创建、加载、销毁和崩溃处理。
- 只实现 Phase 0 已选定的截图后端和 frame-ready 协议，不同时维护两套正式路径。
- 实现 PNG 最终帧导出。
- 实现 60 个 PNG 帧通过带背压的 stdin 写入 FFmpeg `image2pipe`。
- 固定 MP4 编码参数，并通过临时文件实现成功提交和失败回滚。
- 将 Phase 0 的连续帧、性能、背压与清理场景迁移为直接驱动正式宿主的开发检查，防止 Electron 或实现升级导致技术路线回退；连续帧检查必须通过仅在开发检查启用的像素 frame-id 或等价图像哈希独立识别截图内容，不能只信任 renderer 返回的 ready frame id；不把实验 renderer 作为长期检查入口。

### 4. 固化剩余交互规则并接入任务生命周期与 IPC

- 以已确认的阻塞式进度界面确定保存取消、任务互斥、进度心跳、取消和清理所需的 IPC 语义；补齐失败重试、完成提示和“打开文件夹”决策后再固定完整契约。
- 新增共享导出类型、preload 固定桥和 main IPC handler。
- 实现单任务互斥、覆盖整个活动任务的最长 1 秒状态心跳、1 秒内取消接收确认、错误归一化和 shutdown 协调。
- 导出前等待结果编辑字段保存队列完成，再创建权威快照。

### 5. 接入可视化隐藏操作栏

- 按 Phase 4 已评审的用户交互规则实现 UI，不在本阶段隐式改变 IPC 语义或产品流程。
- 在现有 `chart-actions` 中加入“导出”按钮和 MP4/PNG 格式选择。
- 保持 hover、键盘 focus、disabled 和正在导出状态可访问。
- 保存路径确认后显示全应用模态进度界面，使背景内容 inert，并将焦点限制在状态区域和取消按钮；导出状态不得出现在共享导出画面中。
- 增加 Electron UI 行为检查，确认按钮只在已有结果且可视化 ready 时可用，并验证导出期间背景不可操作、焦点不会逃逸、取消仍可触发。

### 6. 安装包与实际导出验证

- 正式路径开发完成后，在记录的 Windows 环境中测量并汇报总耗时、各阶段耗时、Electron 与 FFmpeg 峰值内存以及系统稳定性。本计划不设置耗时或内存数值硬门槛，由项目维护者根据报告决定继续发布、要求优化或更换路线，并记录决定。
- 将 Windows FFmpeg 放入 `extraResources`，验证开发态与安装包使用不同但稳定的资源解析路径。
- 在断网环境运行 unpacked 或已安装应用，确认不会下载或查找额外 Chrome。
- 实际导出代表性 MP4 和 PNG，并检查尺寸、帧率、帧数、编码格式、像素格式、最终画面和中文字体。
- 验证取消、覆盖、路径含空格与中文、应用退出和 FFmpeg 失败场景。
- 使用正式导出路径复测连续帧像素正确性、进度/取消活性、背压、隐藏 renderer 与编码器崩溃、应用退出和临时文件清理；测量耗时和内存并提交项目维护者评审，确认所需回归场景已脱离 Spike 独立运行。
- 通过删除前门槛后，删除 Phase 0 实验脚本、实验 renderer、查询入口、探针样式和对应 package scripts；重新构建并复验安装包，确认正式导出仍然通过且实验查询入口和代码未进入最终产物。
- 删后复验通过后，以人工编写的单一归档文档替代 Phase 0 原始 JSON 和报告目录，并同步更新本文档中的实验结果链接。

### 7. 移除 Remotion

仅在保留 Remotion 的情况下，新 Electron 导出路径已经通过 Phase 6 开发态与安装包检查，并经项目维护者性能/内存评审获准继续后执行：

- 删除 `src/visualize/remotion/` 及旧 Remotion composition。
- 删除基于 `@remotion/bundler`、`@remotion/renderer` 的旧导出入口和不再使用的路径辅助代码。
- 删除 `remotion`、`@remotion/bundler`、`@remotion/renderer` 及其传递产物，不将它们降级为 devDependencies。
- 更新 `package.json`、lockfile、构建配置和导出命令。
- 检查安装包中不再包含 Remotion compositor、Remotion FFmpeg 或额外浏览器资源。
- 删除后重新构建开发态与 Windows 安装包，复跑连续帧像素正确性、正式 MP4/PNG、生命周期和断网导出检查；只有该轮复验通过，移除工作才算完成。
- 更新 README、Architecture、Visualize Frontend Implementation 和 Development Checks，使 Electron 自研导出成为唯一素材导出宿主。

## 验证矩阵

### 自动化检查

- 动画逐帧测试：帧端点、完成帧、最终状态和总帧数。
- CDF view model 与共享场景现有测试。
- 导出请求与事件的输入校验测试。
- FFmpeg 命令构造测试：固定 `libx264`、CRF 18、60 FPS、`yuv420p`、无音轨和 `image2pipe` 输入，不允许 renderer 覆盖参数。
- ExportTask 的单任务互斥、进度、取消、FFmpeg 失败和临时文件清理测试。
- 结果字段保存完成后才创建导出快照的竞态测试。
- Electron 行为测试：隐藏操作栏中的导出入口、格式选择、模态进度、背景 inert、焦点限制、进度心跳和取消。

### 实际产物检查

- PNG 为 3840×2160，内容对应 `ANIMATION_COMPLETION_FRAME`（当前为第 57 帧）且不包含操作栏。
- MP4 为 3840×2160、60 FPS、60 帧、H.264、`yuv420p`、无音轨。
- MP4 第 0、56、57、59 帧分别符合动画契约。
- Electron 预览、PNG 和 MP4 在字体、布局、颜色、CDF、marker 和统计内容上保持一致。
- Phase 6 中 Windows 安装包断网导出成功，不下载或查找额外 Chromium；Phase 7 删除后重新验证安装包不再包含 Remotion 及其浏览器或 FFmpeg 产物。

## 主要风险与应对

### 截到旧帧

React 状态提交不等于 Chromium 已完成画面呈现。Phase 0 只证明固定 Electron 和 fixture 中“commit ready 后执行 CDP capture”的时序可靠；正式路径每帧使用带 job/frame 标识的 ready 握手，并通过实际连续帧像素测试检查错帧，不得用固定 sleep 作为同步协议。

### 4K PNG 截图造成调度延迟

CDP 截图包含 4K 合成、PNG 编码、协议传输和 base64 解码，并与普通窗口共享 Electron browser/main、GPU 和系统资源。产品选择用阻塞式进度界面接受导出期间的普通交互延迟，但进度和取消仍是活性契约；若相邻心跳超过 1 秒、main 不能在 1 秒内确认收到取消请求，或系统将应用判定为无响应，必须重新评估进程隔离或非逐帧 PNG 路线。

### 导出内存峰值

Phase 0 分别观测到 Electron 进程树约 3 GiB、FFmpeg 约 4 GiB 的采样峰值，二者不代表同一时刻的精确总和，但不能由阻塞式 UI 规避。正式宿主不得保留已送出的 PNG/base64 帧，Phase 3 和 Phase 6 必须重新测量真实任务峰值并记录测试环境、采样方法和系统稳定性。本计划不为耗时或内存设置数值硬门槛；项目维护者根据正式报告决定是否允许继续、要求优化或更换路线。

### DPI 与跨平台像素差异

专用导出窗口使用 `offscreen: true`，强制 device scale factor 1，并对截图尺寸做运行时断言。第一版实际导出覆盖 CI 基准环境和 Windows 开发/安装环境；新增其它安装包目标时补充对应平台验证。

### FFmpeg 分发与许可

第一版已决定使用 Windows FFmpeg 可执行文件和 `libx264`，剩余风险是最终 build 的来源、组件组合及其具体分发义务尚未关闭。Phase 1 必须完成来源、校验、构建信息和合规材料记录；不得依赖用户机器预装 FFmpeg，也不得把 Electron 自带的 `ffmpeg` 动态库当作命令行编码器使用。

## 完成标准

满足以下条件后，Electron 导出能力视为完成：

- 用户能从可视化隐藏操作栏分别导出 MP4 和 PNG。
- 导出文件满足固定画面、帧和编码契约。
- 进度、取消、失败、覆盖和退出清理行为可观察且通过验证。
- 导出期间其它应用操作被可靠屏蔽，整个活动任务的进度、阶段或状态心跳间隔不超过 1 秒；点击取消后 renderer 立即显示 cancelling，main 在 1 秒内确认收到请求。
- 正式耗时、内存和系统稳定性报告已经提交项目维护者评审，且评审决定允许发布；如果决定要求优化或更换路线，导出能力尚未完成。本计划不以固定数值自动判定通过或失败。
- 开发态和正式安装包均可在无额外浏览器、无网络下载的条件下导出。
- Remotion 源码、直接依赖、传递打包产物和维护文档已经全部移除。
- Electron 与素材导出继续只消费经过校验的 `AnalysisV2 + DisplayConfig v2`，共享场景与动画语义没有分叉。
