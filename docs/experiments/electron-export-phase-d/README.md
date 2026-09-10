# Electron 导出阶段 D 性能复验

## 结论状态

2026-09-10 在 Windows x64 完成阶段 D 完整矩阵。21 个 run（每场景一次预热、五次正式测量及一次取消）全部有效；没有活性契约违约、崩溃、超时、产物失败或资源残留。本阶段不设置新的性能数值门槛，维护者最终选择为：**优化 Analysis 分析流程为流式读取**。

本轮没有执行低内存/OOM 稳定性测试。Phase 0 使用逐帧探针 build、旧实验宿主和不同 FFmpeg，其结论只能作为背景参考，不能据此严格计算回归比例。

## 环境与方法

- Git commit：`7946aeb1782e3fcf78ee7ab2c3d38cdab536bcb2`。
- Windows `10.0.26200`，13th Gen Intel Core i9-13900HX，32 个逻辑 CPU，约 63.7 GiB RAM。
- Electron 43.3.0 / Chromium 150.0.7871.212 / Node 24.18.1。
- FFmpeg 9.0.1，SHA-256 `efcef8a7659d8c21e5d33f4a82c53f0cb8048ffdeba5820cbfd2a3799e55556a`；ffprobe SHA-256 `c8c73758b6cc52aa31286bf166047d80aaa126515a07a9a4796f11f59e61328d`。

测量使用无逐帧探针的 production build、正式 `ExportTaskCoordinator` / `ExportHost`、正式桌面与导出 renderer，以及仓库源码构建的固定 FFmpeg。每 500 ms 在同一采样中记录 Electron 进程树及 FFmpeg、core、analyzer 分组工作集；总工作集峰值由同一时刻的值计算，不相加各进程的独立峰值。

背景负载校准到预计覆盖 30 秒：模拟为 93,000,000 runs；分析使用 651,000,000 runs、约 7.28 GiB 的 GSR。分析校准峰值工作集约 7.28 GiB，未超过物理内存的 25%。五个正式模拟和分析 run 均为 100% 重叠。

## 有效运行汇总

时间为 ms，内存为 MiB；阶段列依次为 preparing/rendering/finalizing 中位数。对五个原始值使用 nearest-rank P95，因此 P95 等于最大值。

| scenario | valid | total median / P95 / max | phases median | event max gap | timer P95 | peak WS increment | min available |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| idle | 5/5 | 11748.5 / 11790.1 / 11790.1 | 415.8 / 11295.2 / 14.9 | 595.9 | 12.6 | 4268.0 | 42144.4 |
| simulation | 5/5 | 19360.8 / 19562.5 / 19562.5 | 982.1 / 18361.5 / 17.2 | 989.5 | 12.5 | 4420.7 | 41057.6 |
| analysis | 5/5 | 12269.3 / 12384.7 / 12384.7 | 442.8 / 11794.4 / 16.5 | 902.3 | 12.2 | 8193.2 | 38321.0 |

## 五次原始耗时

按实际轮换执行顺序列出每个场景的正式 run，单位为 ms。

| scenario | total | preparing | rendering | finalizing |
| --- | --- | --- | --- | --- |
| idle | 11790.1, 11757.6, 11748.5, 11677.5, 11720.0 | 420.4, 412.5, 422.9, 415.1, 415.8 | 11354.7, 11337.5, 11295.2, 11251.6, 11288.3 | 14.9, 7.6, 30.3, 10.8, 15.8 |
| simulation | 19360.8, 19540.7, 19219.4, 19285.3, 19562.5 | 982.1, 910.4, 972.6, 989.6, 985.7 | 18361.5, 18613.0, 18229.5, 18281.6, 18375.7 | 17.0, 17.3, 17.2, 14.0, 201.0 |
| analysis | 12384.7, 12269.3, 12210.5, 12294.7, 12255.5 | 440.9, 457.5, 435.5, 442.8, 445.2 | 11924.4, 11794.4, 11759.5, 11835.4, 11794.1 | 19.3, 17.3, 15.5, 16.5, 16.0 |

## 响应、取消与有效性

renderer 收到的 progress、heartbeat 与 terminal 事件最大间隔均小于 1 秒。轻量定时器延迟 P95 的场景最大值为 12.6 ms；该指标仅作描述，不设门槛。

| scenario | cancelling received (ms) | validity |
| --- | ---: | --- |
| idle | 0.9 | valid |
| simulation | 0.7 | valid |
| analysis | 0.8 | valid |

默认 MP4 与 PNG 均通过 ffprobe 和 PNG header 规格检查。所有 run 的内存采样完整，退出后未发现 FFmpeg、隐藏导出窗口、partial/backup 或 native 子进程残留。原始逐 run JSON、同步内存样本、事件时间线和生成报告位于忽略的 `tmp/electron-export-performance/full-2026-09-10T04-30-42-513Z/`。

## 临时工具生命周期

复验入口为 `pnpm run measure:electron-export`；`--quick` 只用于开发冒烟，不能用于路线决策。阶段 E 在本报告归档和正式回归证据确认后，将该入口与 Phase 0 Spike、实验入口及探针样式一并删除。
