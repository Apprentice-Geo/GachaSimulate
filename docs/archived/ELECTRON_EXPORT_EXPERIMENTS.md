# Electron 导出实验归档

> 本文已于 2026-9-11 归档，记录 Electron 自研素材导出路线在 Phase 0 和阶段 D 的三轮实验

实验 harness、原始数据和临时性能入口已在阶段 E1 删除；本文只保留能解释长期技术决策的环境、结果和限制。正式实现、检查矩阵与分发边界分别以源码、[Development Checks](../DEVELOPMENT_CHECKS.md) 和 [FFmpeg 分发文档](../FFMPEG_DISTRIBUTION.md) 为准。

## 2026-08-27：Phase 0 截图后端与 frame-ready 边界

实验在 Windows 10.0.26200、13th Gen Intel Core i9-13900HX、约 63.7 GiB RAM 上运行，使用 Electron 43.3.0、Chromium 150.0.7871.212、Node 24.14.1 和 Playwright 1.61.0。FFmpeg 为 Gyan.dev 的 8.0.1 essentials build，SHA-256 为 `5af82a0d4fe2b9eae211b967332ea97edfc51c6b328ca35b827e73eac560dc0d`，启用 GPL 和 libx264。

`capturePage()` 在 React commit、字体就绪、单 RAF 和双 RAF 边界下均未形成可靠协议：前三种边界分别出现 37、30、29 次探针错帧；双 RAF 虽无探针错帧，第 57–59 帧的无探针 PNG 仍出现两个不同哈希。CDP `Page.captureScreenshot` 的四种边界、12 组完整序列均为零错帧，最早可靠边界是 React commit，且第 57–59 帧哈希一致。因此正确性上选择 CDP + commit frame-ready 边界。

CDP 截取 60 帧为 13.07–13.42 秒，中位数 13.08 秒；截图并写入 FFmpeg 为 16.69–17.36 秒，中位数 16.80 秒，满足当时的 20 秒和 30 秒吞吐门槛。但普通 renderer 响应 P95 为 166.44 ms、main 响应 P95 为 152.99 ms，UI 最大值 382.74 ms，未满足 P95 100 ms、最大值 250 ms 的预设交互门槛，所以实验的原始自动结论是 **no-go**。

随后产品决定把导出定义为覆盖整个应用的阻塞式任务，期间只保留进度、取消和退出协调，普通页面交互延迟不再是截图后端硬门槛。路线因此采用 CDP `Page.captureScreenshot`，这属于实验后的验收口径调整，不表示 CDP 通过了原始门槛。

代表性产物为 3840×2160、H.264、`yuv420p`、60 FPS、60 帧、1 秒且无音轨的 MP4，SHA-256 为 `f3ac13de810bcd6342b677578df5de902a51c7e920186ebaf5cdfd9b0b7805b6`。FFmpeg 的五次正式运行都触发并等待 stdin 背压；取消、强制结束编码器、renderer 崩溃和应用退出均能停止生产并清理 partial，实验结束后没有残留 FFmpeg 或 `.partial.mp4`。当时观测到 Electron 进程树约 2.95 GiB、FFmpeg 约 4.00 GiB 的独立峰值，促使正式路线继续验证内存和清理边界。

## 2026-09-10：正式 CDP、固定源码 FFmpeg 与旧 analyzer

首次阶段 D 完整矩阵基于 commit `7946aeb1782e3fcf78ee7ab2c3d38cdab536bcb2`，仍使用同一 Windows 主机，运行 Electron 43.3.0、Chromium 150.0.7871.212、Node 24.18.1。固定源码构建的 FFmpeg 9.0.1 SHA-256 为 `efcef8a7659d8c21e5d33f4a82c53f0cb8048ffdeba5820cbfd2a3799e55556a`，ffprobe SHA-256 为 `c8c73758b6cc52aa31286bf166047d80aaa126515a07a9a4796f11f59e61328d`。

测量使用无逐帧探针的 production build、正式 `ExportTaskCoordinator`、`ExportHost`、桌面 renderer 和导出 renderer。空闲、模拟中、分析中各预热一次、正式运行五次并取消一次，共 21 个 run，全部有效；模拟和分析正式 run 均实现 100% 重叠，产物规格、事件时间线、内存采样、取消和退出资源残留检查均通过。

五次正式运行的总耗时中位数分别为空闲 11,748.5 ms、模拟中 19,360.8 ms、分析中 12,269.3 ms。背景分析校准使用 651,000,000 runs、7,812,000,143 bytes（约 7.28 GiB）的 GSR；旧 analyzer 用时约 40.43 秒，峰值工作集 7,817,818,112 bytes（约 7.28 GiB）。这表明逐 run 数组使分析内存随 GSR 线性增长，维护者因此决定将 analyzer 改为流式聚合。

## 2026-09-10：流式 analyzer 复验

流式优化后的测试工作树为 commit `fef37a503283945422d70cac47128b8e15d3bdca`，随后连同实验结论提交为 `6377117`。主机、Electron 和固定 FFmpeg 材料与上一轮相同。矩阵仍为三个场景各一次预热、五次正式测量和一次取消，共 21 个 run；全部有效，模拟和分析均 100% 重叠，没有崩溃、超时、产物失败、采样不完整或资源残留。

分析校准处理 1,000,000,007 runs、12,000,000,227 bytes（12.00 GB）的 GSR，用时 44.68 秒，峰值工作集 14,217,216 bytes（13.6 MiB）。相对旧 analyzer 的校准结果，吞吐约提升 39%，峰值工作集下降约 99.82%，约为原来的 1/550。结果支持保留正式 CDP + 固定 FFmpeg 路线，并确认流式 analyzer 已消除大 GSR 的主要内存风险。

该轮沿用 test-only 的“一秒内收到 progress、heartbeat 或 terminal”检查。11 次检查轻微超过一秒，最大间隔为 1038.6 ms；取消确认仍为 0.8–1.0 ms，轻量定时器延迟 P95 最大为 12.8 ms，所有 run 仍满足实际任务正确性和资源安全要求。

## 最终路线结论

正式导出继续使用阻塞式桌面流程、隐藏 ExportHost renderer、CDP `Page.captureScreenshot` 和 React commit frame-ready 边界。
