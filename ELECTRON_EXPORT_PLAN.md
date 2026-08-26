# Electron 素材导出计划

## 状态

本文档记录 Electron 自研素材导出的实施计划。计划完成并通过开发态与安装包验证后，项目将移除 Remotion 导出实现及全部 Remotion 依赖，不在正式运行时或开发依赖中继续保留 Remotion。

当前首要工作是 Phase 0 技术 Spike。在截图正确性、逐帧同步、4K 性能和 FFmpeg 生命周期完成实验前，不确定正式截图后端，也不开始完整 IPC、ExportTask 或导出 UI 实现。

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
- MP4 使用 H.264、CRF 18、`yuv420p`，不包含音轨。

动画帧必须由共享时间线确定性计算。导出宿主不得运行基于真实时钟的动画，也不得依赖导出机器能否实时达到 60 FPS。

### 用户入口

导出按钮放入可视化页面现有的隐藏操作栏，即 `VisualizeShell` 中包含“重放动画”和“选择结果”按钮的 `chart-actions` 区域。

- 操作栏继续在图表区域 hover 或 focus-within 时显示。
- 新增一个“导出”按钮，与“重放动画”和“选择结果”并列。
- 点击“导出”后选择“MP4 视频”或“PNG 图片”，再由 main 打开对应的保存对话框。
- 导出画面使用 `show_controls={false}`，隐藏操作栏本身不得出现在导出文件中。
- `src/visualize/` 只接收宿主提供的导出回调，不直接调用 Electron IPC，保持平台无关。

## 待 Phase 0 确定的渲染与编码路线

Phase 0 使用专用隐藏 BrowserWindow 作为共同实验宿主。该窗口只加载随应用构建的本地导出页面，并直接渲染共享 `VisualizeScene`。正式实现从以下两个截图后端中选择：

```text
AnalysisV2 + DisplayConfig
        -> validate
        -> build_cdf_view_model
        -> hidden BrowserWindow / VisualizeScene(frame)
        -> ScreenshotBackend
             A. webContents.capturePage({ stayHidden: true })
                -> NativeImage.toPNG()
             B. CDP Page.captureScreenshot(PNG)
                -> base64 decode
        -> PNG file or FFmpeg image2pipe
        -> PNG / MP4
```

隐藏窗口固定使用 3840×2160 内容尺寸、device scale factor 1，并禁用后台节流。导出页面不挂载交互用 `VisualizeApp`，而是接收明确的 CDF view model 和 frame，按下式构造共享动画进度：

```text
elapsed_ms = min(frame, ANIMATION_COMPLETION_FRAME) / VIDEO_FPS * 1000
```

两个候选后端都产生 PNG 帧。MP4 将连续 PNG 写入 FFmpeg `image2pipe`，避免在磁盘保存完整图片序列。Phase 0 必须分别验证正确性、性能、内存和主窗口响应性，不预设 CDP 或 `capturePage()` 胜出。若二者都不能满足预先记录的验收门槛，应重新评估逐帧 PNG 中间格式或进程隔离方案，不从不合格方案中强行选择。第一轮 Spike 不扩展到 `NativeImage.toBitmap()`，因为其原始像素格式是平台相关实现细节。

FFmpeg 作为按目标平台构建的真实文件随安装包分发，通过 `extraResources` 放在 ASAR 外。main 只解析应用内受信任的 FFmpeg 路径，不接受 renderer 提供可执行文件路径或命令行参数。

项目可以接受分发包含 `libx264` 等 GPL 组件的 FFmpeg build。FFmpeg 继续作为独立可执行文件由子进程调用，本计划不要求因此将项目自身代码改为 GPL；正式发布前仍须核对具体组合，并履行所选 GPL build 对应的许可证声明、完整对应源码、构建配置与修改记录等分发义务。若存在满足输出契约且许可与分发成本更合适的 H.264 编码器，应在固定最终 build 前一并比较。

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
- 管理隐藏 BrowserWindow、逐帧握手、截图、FFmpeg、进度和取消。
- 验证 IPC 输入、限制单一活动导出任务，并负责所有临时文件清理。

### 隐藏导出 Renderer

- 开启 context isolation，关闭 Node integration，只加载本地可信资源。
- 接收已构建的 CDF view model 和目标 frame。
- 等待 React 提交、`document.fonts.ready` 和画面呈现后，携带 job id 与 frame id 返回 ready 确认。
- 不访问文件系统，不启动 FFmpeg，不决定输出路径。

## 导出任务模型

共享类型定义至少包含：

```text
ExportFormat = "mp4" | "png"
ExportStage = "preparing" | "rendering" | "finalizing"
ExportEvent = started | progress | completed | failed | cancelled
```

任务状态转换为：

```text
idle
  -> preparing
  -> rendering
  -> finalizing
  -> completed | failed | cancelled
```

同一时间最多允许一个导出任务。开始后使用不可变结果快照；用户随后编辑字段或切换页面不得改变正在生成的文件。

MP4 进度以已确认并送入编码器的帧数为主，finalizing 阶段等待 FFmpeg 完成编码和封装。PNG 在准备完成后导出一帧，可使用阶段状态而不伪造细粒度百分比。

上述状态只定义 ExportTask 生命周期，不代替 renderer 的用户交互设计。在固定对外 IPC 事件语义和进入导出 UI 编码前，必须先明确并记录完整用户流程，包括格式选择、保存对话框取消、各阶段按钮与状态文案、取消入口、PNG 进度呈现、第二次导出请求、失败重试、完成提示以及是否提供“打开文件夹”。这些规则完成设计并通过评审后，才实现正式 IPC 契约和 UI。

## 文件安全与生命周期

- 保存路径只能来自 main 的原生保存对话框。
- 默认文件名由当前 GSR 文件 stem 派生，并按格式添加 `.mp4` 或 `.png`。
- 导出先写入目标目录中的唯一临时文件，成功后再替换最终文件。
- 失败、取消或应用退出时关闭 stdin、终止并等待 FFmpeg、销毁隐藏窗口并删除临时文件。
- 应用关闭时将导出任务纳入现有 shutdown 流程；不得留下孤儿进程或半成品输出。
- 覆盖已有文件必须经过保存对话框确认，失败时不得破坏原文件。

## 实施阶段

### 0. 验证技术路线

Phase 0 只建立足以回答架构问题的最小 Spike，不提前实现正式 IPC 或产品 UI。

- 建立最小本地导出页面和隐藏 BrowserWindow，使用固定 3840×2160、device scale factor 1、禁用后台节流的同一实验宿主。
- 实现 `capturePage({ stayHidden: true }) -> toPNG()` 与 `Page.captureScreenshot(PNG) -> base64 decode` 两个候选后端；使用项目固定 Electron 版本及其内置 CDP，不依赖外部 Chrome。
- 使用专用同步探针让每帧携带可机器读取的 frame id，连续验证 60 帧无旧帧、错帧或意外重复；生产场景第 57～59 帧按契约允许相同。
- 对比 React commit、字体就绪、单 RAF 和双 RAF 等候选边界，确定 `setFrame -> paint barrier -> ready -> screenshot` 的可靠协议，不使用固定 sleep。
- 对两个截图后端分别运行“截图到内存”和“截图后写入真实 FFmpeg”两类实验，避免编码吞吐掩盖截图后端差异。Spike 可以使用来源、版本、编码器和构建信息均有记录的代表性 FFmpeg build；若 Phase 1 选定的最终分发 build 或编码器不同，必须用最终方案复测受影响的吞吐、背压和生命周期指标。
- 分阶段记录 `setFrame -> ready`、截图返回、`toPNG()` 或 base64 decode、stdin 写入与 drain、FFmpeg finalizing；同时记录 60 帧总时间、单帧平均与 P95、main event-loop 最大延迟、主窗口响应探针以及 Electron 与 FFmpeg 进程树峰值内存。
- 在正式测量前完成预热，按固定次数重复实验。实验开始前记录正确性硬门槛、可接受的绝对耗时与 UI 延迟，以及切换后端所需的最小重复性收益，避免看到结果后再定义成功标准。
- 验证 FFmpeg stdin `write() === false -> drain`、取消、编码器崩溃、隐藏 renderer 崩溃和应用退出；确认任务停止生产帧、关闭管道、终止并等待子进程且不遗留半成品。
- 形成 Spike 结果记录，明确选定的截图后端、frame-ready 边界、测量环境、原始数据、未决风险和继续实施结论。只有该结论通过后才进入后续阶段。

### 1. 固化共享逐帧契约与 FFmpeg 基线

- 将当前位于 Remotion 目录中的 frame state 计算迁移到平台无关的动画模块。
- 保持第 0～59 帧、第 57 帧完成及 57～59 帧最终状态一致的测试。
- 保证 `VisualizeScene` 的导出模式不包含控件，也不依赖真实时钟、CSS 动画或宿主缩放。
- 在实现正式 MP4 路径前，确定各平台 FFmpeg build 的来源、版本、校验值、构建配置、实际 H.264 编码器和许可证状态；若选择 GPL build，同步确定对应源码、许可证文本、修改记录和构建信息的分发方式。

### 2. 建立导出 Renderer

- 为 Electron 构建增加专用本地导出页面入口。
- 渲染固定尺寸的 `VisualizeScene`，复用共享 CSS、字体和 CDF view model。
- 定义初始化、设置 frame、frame ready 和错误消息协议。
- 在首次截图前等待字体和初始布局完成；每帧截图前验证返回的 job id 与 frame id。

### 3. 建立截图与 FFmpeg 宿主

- 实现隐藏 BrowserWindow 的创建、加载、销毁和崩溃处理。
- 只实现 Phase 0 已选定的截图后端和 frame-ready 协议，不同时维护两套正式路径。
- 实现 PNG 最终帧导出。
- 实现 60 个 PNG 帧通过带背压的 stdin 写入 FFmpeg `image2pipe`。
- 固定 MP4 编码参数，并通过临时文件实现成功提交和失败回滚。
- 将 Phase 0 的性能与同步探针保留为开发检查入口，防止 Electron 或实现升级导致技术路线回退。

### 4. 设计用户交互规则并接入任务生命周期与 IPC

- 先完成并评审用户交互规则，用其确定保存取消、重复请求、失败重试、取消和完成结果所需的 IPC 语义；不得让正式 IPC 契约先于这些产品决策固化。
- 新增共享导出类型、preload 固定桥和 main IPC handler。
- 实现单任务互斥、进度事件、取消、错误归一化和 shutdown 协调。
- 导出前等待结果编辑字段保存队列完成，再创建权威快照。

### 5. 接入可视化隐藏操作栏

- 按 Phase 4 已评审的用户交互规则实现 UI，不在本阶段隐式改变 IPC 语义或产品流程。
- 在现有 `chart-actions` 中加入“导出”按钮和 MP4/PNG 格式选择。
- 保持 hover、键盘 focus、disabled 和正在导出状态可访问。
- 导出期间允许隐藏操作栏继续显示任务状态和取消入口，但不得改变共享导出画面。
- 增加 Electron UI 行为检查，确认按钮只在已有结果且可视化 ready 时可用。

### 6. 安装包与实际导出验证

- 将各平台 FFmpeg 放入 `extraResources`，验证开发态与安装包使用不同但稳定的资源解析路径。
- 在断网环境运行 unpacked 或已安装应用，确认不会下载或查找额外 Chrome。
- 实际导出代表性 MP4 和 PNG，并检查尺寸、帧率、帧数、编码格式、像素格式、最终画面和中文字体。
- 验证取消、覆盖、路径含空格与中文、应用退出和 FFmpeg 失败场景。

### 7. 移除 Remotion

仅在新 Electron 导出通过开发态和安装包验收后执行：

- 删除 `src/visualize/remotion/` 及旧 Remotion composition。
- 删除基于 `@remotion/bundler`、`@remotion/renderer` 的旧导出入口和不再使用的路径辅助代码。
- 删除 `remotion`、`@remotion/bundler`、`@remotion/renderer` 及其传递产物，不将它们降级为 devDependencies。
- 更新 `package.json`、lockfile、构建配置和导出命令。
- 检查安装包中不再包含 Remotion compositor、Remotion FFmpeg 或额外浏览器资源。
- 更新 README、Architecture、Visualize Frontend Implementation 和 Development Checks，使 Electron 自研导出成为唯一素材导出宿主。

## 验证矩阵

### 自动化检查

- 动画逐帧测试：帧端点、完成帧、最终状态和总帧数。
- CDF view model 与共享场景现有测试。
- 导出请求与事件的输入校验测试。
- ExportTask 的单任务互斥、进度、取消、FFmpeg 失败和临时文件清理测试。
- 结果字段保存完成后才创建导出快照的竞态测试。
- Electron 行为测试：隐藏操作栏中的导出入口、格式选择、disabled 状态和取消。

### 实际产物检查

- PNG 为 3840×2160，内容对应 `ANIMATION_COMPLETION_FRAME`（当前为第 57 帧）且不包含操作栏。
- MP4 为 3840×2160、60 FPS、60 帧、H.264、`yuv420p`、无音轨。
- MP4 第 0、56、57、59 帧分别符合动画契约。
- Electron 预览、PNG 和 MP4 在字体、布局、颜色、CDF、marker 和统计内容上保持一致。
- 安装包断网导出成功，且没有 Remotion 或额外 Chromium 依赖。

## 主要风险与应对

### 截到旧帧

React 状态提交不等于 Chromium 已完成画面呈现。每帧使用带 job/frame 标识的 ready 握手，并通过实际连续帧测试检查错帧；不得用固定 sleep 作为同步协议。

### 4K PNG 编码阻塞 main

`NativeImage.toPNG()` 是同步压缩步骤，CDP 截图也包含 PNG 编码、协议传输和 base64 解码成本。Phase 0 在正式架构确定前比较两条路径；若二者都未达到验收门槛，再评估独立 Electron 渲染子进程、平台原始像素快速路径或共享纹理。

### DPI 与跨平台像素差异

隐藏窗口强制 device scale factor 1，并对截图尺寸做运行时断言。实际导出至少覆盖 CI 基准平台和当前支持的 Windows 开发/安装环境。

### FFmpeg 分发与许可

在实现正式 MP4 路径前确认目标平台、具体 H.264 编码器、编解码器构建选项、许可证义务和来源记录。项目允许选择 GPL FFmpeg build，但必须随发布流程处理对应源码、许可证与构建记录等义务，并检查所组合组件之间不存在许可证冲突。不得依赖用户机器预装 FFmpeg，也不得把 Electron 自带的 `ffmpeg` 动态库当作命令行编码器使用。

## 完成标准

满足以下条件后，Electron 导出能力视为完成：

- 用户能从可视化隐藏操作栏分别导出 MP4 和 PNG。
- 导出文件满足固定画面、帧和编码契约。
- 进度、取消、失败、覆盖和退出清理行为可观察且通过验证。
- 开发态和正式安装包均可在无额外浏览器、无网络下载的条件下导出。
- Remotion 源码、直接依赖、传递打包产物和维护文档已经全部移除。
- Electron 与素材导出继续只消费经过校验的 `AnalysisV2 + DisplayConfig v2`，共享场景与动画语义没有分叉。
