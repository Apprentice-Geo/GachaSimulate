# Electron 导出 Phase 0 Windows 结果

## 结论

2026-08-27 在 Windows 原生环境完成 Phase 0。现有截图检查使用的唯一 offscreen BrowserWindow 可以复用为实验宿主，不需要再创建第二个离屏窗口；并发响应探针使用独立但非 offscreen 的普通 renderer 窗口。

按实验前记录的吞吐与交互响应门槛，本轮原始结论为 **no-go**：

- `capturePage()` 在 commit、fonts、单 RAF 和双 RAF 边界下均未形成可靠协议。前三种边界分别出现 37、30、29 次探针错帧；双 RAF 虽然探针零错帧，但第 57–59 帧无探针 PNG 产生 2 个不同哈希。
- CDP `Page.captureScreenshot` 在四种边界的 12 组完整序列中均为零错帧，最早可靠边界是 React commit，第 57–59 帧哈希一致。
- CDP 吞吐达到预设门槛，但主循环和普通 renderer 响应延迟未达到当时的门槛，因此原始自动选择结果为空。

完整逐帧数据见 [windows-2026-08-27.json](windows-2026-08-27.json)。

使用目标平台的 FFmpeg 绝对路径复现实验：

```text
pnpm run spike:electron-export -- --ffmpeg <absolute-ffmpeg-path>
```

开发时可追加 `--quick --output tmp/electron-export-spike/quick.json` 做非结论性的冒烟；quick 模式不能用于选择 frame-ready 边界。

## 预设门槛与结果

| 项目                   |                       门槛 |                     CDP 结果 | 判定    |
| ---------------------- | -------------------------: | ---------------------------: | ------- |
| 60 帧截图总时间        |                每次 ≤ 20 s |  13.07–13.42 s，中位 13.08 s | 通过    |
| 60 帧截图并写入 FFmpeg |                每次 ≤ 30 s |  16.69–17.36 s，中位 16.80 s | 通过    |
| 响应探针 P95           |                   ≤ 100 ms | UI 166.44 ms；main 152.99 ms | 失败    |
| 响应探针最大值         |                   ≤ 250 ms | UI 382.74 ms；main 231.43 ms | UI 失败 |
| 正确性                 | 零旧帧、错帧和意外终态差异 |                         通过 | 通过    |

CDP 单帧 `Page.captureScreenshot` 平均 215.48 ms、P95 298.40 ms；base64 转 Buffer 平均 0.05 ms。性能测量阶段不执行用于正确性检查的 `NativeImage.toBitmap()` 探针解码，避免仪器阻塞 main。

Electron 进程树采样峰值为 3,096,348 KiB，FFmpeg 工作集采样峰值为 4,297,908,224 bytes。两者是分别观测到的峰值，不代表同一时刻的精确总和，但已经构成后续路线必须处理的内存风险。

## 实验后产品决策

产品评审决定导出采用覆盖整个应用窗口的模态进度界面，任务期间屏蔽导航、编辑、模拟、配置仓库和第二次导出，只保留进度展示、取消和系统退出协调。约 17 秒的导出等待被视为显式阻塞任务，普通页面交互延迟不再作为截图后端硬门槛。

据此选择 CDP `Page.captureScreenshot` 和 React commit frame-ready 边界继续实施。这个决定是实验完成后的产品验收口径变更，不代表 CDP 通过了原始响应门槛，也不修改原始 JSON 中的 no-go 判定。

阻塞式交互不能豁免任务活性和资源安全：任务生产期间进度或阶段心跳间隔不得超过 1 秒，取消必须在 1 秒内进入 cancelling 状态；正式实现仍须复测真实任务内存，并在最低支持内存环境验证不会因换页或 OOM 失稳。

## 环境与产物

- Electron 43.3.0 / Chromium 150.0.7871.212 / Playwright 1.61.0。
- Windows 10.0.26200，13th Gen Intel Core i9-13900HX，约 63.7 GiB RAM。
- FFmpeg 8.0.1 essentials build（Gyan.dev），启用 GPL、libx264；其完整版本、构建配置、路径和 SHA-256 已保存在原始 JSON。
- 代表性 MP4 为 3840×2160、H.264、`yuv420p`、60 FPS、60 帧、1 秒、无音轨，SHA-256 为 `f3ac13de810bcd6342b677578df5de902a51c7e920186ebaf5cdfd9b0b7805b6`。文件位于忽略的 `tmp/electron-export-spike/cdp-0.mp4`。
- FFmpeg 的 5 次正式运行均在 60 帧上触发并等待 stdin 背压；取消、强制结束编码器、renderer 崩溃和应用退出协调均停止生产并清理 partial 文件。实验结束后没有残留 FFmpeg 进程或 `.partial.mp4`。

## 后续路线

按主计划进入 Phase 1，并在正式 ExportTask 与阻塞式进度 UI 中保留进度、取消、崩溃和退出清理验证。若进度/取消活性或最低支持内存环境验收失败，再评估独立 Electron 渲染进程或非逐帧 PNG 路线。
