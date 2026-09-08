# FFmpeg 开发使用与分发状态

## 当前决定与已验证范围

截至 2026-09-08，Windows x64 离线自编译入口已经完成本机连续两次源码构建、完整 ExportHost 集成验证及阶段 B 的 Windows CI 验收。项目从固定源码构建 zlib、x264 与 FFmpeg，不把第三方二进制作为正式分发备选。执行顺序见 [Electron 导出计划](../ELECTRON_EXPORT_PLAN.md)。

阶段 A 原验证环境为 Windows x64、Windows 原生 Node/pnpm、MSYS2 UCRT64/Bash、MinGW-w64 GCC、NASM、make 和 pkgconf；当时 zlib 使用 UCRT64 静态库。当前构建已扩展为固定上游源码依次编译 zlib、x264、FFmpeg，并收集 FFmpeg 专项发布材料。工具链仍采用 MSYS2 滚动版本，构建脚本本身保持离线。

阶段 A 已完成，本机编译、失败保护、PE 依赖、隔离 PATH 运行和导出检查已通过。原后置的干净 Windows x64 断网验收已按项目约定由阶段 B 的 Windows CI 完成；这不表示安装包或分发验收通过。

## 目标产物与用途

| 产物 | 用途 | 应用安装包 |
| --- | --- | --- |
| ffmpeg.exe | PNG image2pipe 输入、libx264 编码及 MP4 封装 | 携带 |
| ffprobe.exe | 独立探测程序，开发/CI 检查编码、尺寸、帧率、帧数、像素格式和音轨 | 不携带 |
| 必要运行依赖与声明 | 支持最终链接方式及分发材料 | 按实际依赖与复核结果携带 |

ffmpeg 与 ffprobe 来自同一套 FFmpeg 源码。ffprobe 不参与用户导出，也不替代连续帧像素检查。x264 构建目标是供 FFmpeg 链接的库，不要求分发 x264 命令行工具。

优先裁剪为编码、探测和回归所需组件，具体 configure 参数由脚本和能力验证确定。FFmpeg 自身静态库不等于所有外部依赖均静态链接，须检查最终依赖；开发机运行成功不能替代干净环境验证。

## 离线构建入口

源码准备、脚本职责、参数和执行顺序统一见 [scripts README](../scripts/README.md)。精确源码身份由 [源码锁](../scripts/ffmpeg_windows_source_lock.json) 维护，编译参数与产物检查行为见 [编译与产物检查](../scripts/README.md#编译与产物检查)。

## MSYS2 UCRT64 环境

工具链准备命令、滚动版本记录和离线边界见 [环境与运行顺序](../scripts/README.md#环境与运行顺序)。工具链变化后仍需重新执行本文要求的产物与集成验收。

## 构建材料与阶段 A 验收

材料内容、收集规则和打包检查见 [材料收集与打包](../scripts/README.md#材料收集与打包)。收集完成不代表可重复构建、安装包或分发验收已经通过。

在准备完整环境后，应连续运行构建入口两次，并分别保存材料和哈希；不要求二进制逐位一致。两次均须检查 `-version`、`-buildconf`、能力清单、失败时旧产物保护，并按 [Development Checks](DEVELOPMENT_CHECKS.md#windows-x64-electron-导出检查) 运行 ExportHost 单元、production build、探针 build 和真实集成检查。阶段 B 已在 Windows CI 中完成后置验收与证据归档，具体约定见 [Electron 导出计划](../ELECTRON_EXPORT_PLAN.md)。

2026-09-06 至 2026-09-07 本机验证记录：

- 连续两次完整源码构建成功；两次 `bin/` 均只有 ffmpeg.exe、ffprobe.exe。源码缓存保持固定且干净，第二次正常替换目标，材料文件结构一致。
- 错误归档哈希、脏 x264、独立 worktree 中的非固定提交、错误 `MSYSTEM` 均按预期拒绝，每项前后旧二进制哈希不变。最初构建因不支持的 `-parsers` 在验证阶段失败，旧产物也未改变；修正验证方式后重新完整构建。
- 两次版本、buildconf、decoder/encoder/demuxer/muxer/protocol/filter/parser 清单均已核实；PE 仅导入 Windows 系统 DLL。两个程序分别复制到普通临时目录，在仅含 Windows 系统目录的 PATH 下运行成功。
- `format:check`、`lint`、`typecheck`、`test:visualize:cdf`（22 项）、`test:electron-export`（21 项）、production build、探针 build 和强制完整 `test:electron-export:integration` 均通过。集成使用第二次自编译产物，无 PATH/Gyan 回退，也未使用 PNG-only 模式。
- 集成覆盖 3840×2160 PNG、60 帧 H.264 MP4、60 FPS、yuv420p、无音轨、第 0–59 帧连续性、末尾画面、编码器/renderer 故障、取消、退出与临时文件清理；背压等待及提前退出由宿主单元测试覆盖。`finally` 清除两个探针/集成环境变量后再次 production build，最终 `out/` 不含探针。

本机材料分别保存在 `tmp/ffmpeg-verification/run-1/materials/`、`tmp/ffmpeg-verification/run-2/materials/`；当前安装材料位于 `build/ffmpeg/win32-x64/materials/`。失败检查与项目验证日志保存在 `tmp/ffmpeg-verification/`。这些目录被 Git 忽略，复核或长期留存时须另行归档，不能从仓库提交恢复。

| 构建 | ffmpeg.exe SHA-256 | ffprobe.exe SHA-256 |
| --- | --- | --- |
| run-1 | `bf8ce091db606b5bc78260a914627ee499bf50228866a842f4c7d8dc30cba0ad` | `492b6ae834561df7efcf00a348108b222f3c0d1e1705eff673b7e3a7fdea3261` |
| run-2 | `287fd86e3f12517fe9cb1415e953f6cc0bf3091304a7f6a57034f8be5ccc1b99` | `d970f5359fbdf8b2aa9e52e580699842532438399b0ada2e3440ac07b55c3082` |

实际工具记录包括 GCC 16.2.0、ld 2.47.20260726、make 4.4.1、pkgconf 3.0.5、NASM 3.02、Git 2.55.0 和 Bash 5.3.15；完整包版本见各次 JSON 快照。这些是本次构建记录，不是工具版本约束。阶段 B 的 Windows CI 继续记录每次实际工具版本。

普通 CI 已改为从固定源码构建 FFmpeg，并把该 job 的二进制直接交给 ExportHost 集成检查；Gyan 准备入口不再用于 CI。Windows CI workflow 及项目约定的干净 Windows x64 验收已经通过，阶段 D 仍负责把 FFmpeg 接入应用安装包。

## FFmpeg 专项发布材料

材料生成行为与测试入口统一见 [scripts README](../scripts/README.md#材料收集与打包)，发布流程见 [Release 与旧入口](../scripts/README.md#release-与旧入口)。历史材料应与对应 Release 一同保留。

当前安装包尚不携带 FFmpeg；阶段 D 接入时仍须把精简许可证和对应版本材料下载入口放入安装包，并核对包内 FFmpeg 哈希。范围仅为 FFmpeg 及其依赖，不扩展为整个应用的许可证清单。

2026-09-07 本机扩展验证：三份固定源码构建、zlib 上游检查、私有库链接校验、PE/隔离 PATH 运行、材料包及错误路径检查、x264 bundle 离线恢复与版本一致性、导出相关单元检查和完整 ExportHost 集成通过，最后恢复无探针 production build。运行库声明缺口为空。实际源码在线准备验证成功获取 zlib 和 x264；FFmpeg 官网下载本次未完成，使用原有且通过锁定哈希校验的归档。远端 Release 工作流仍待阶段 D 的实际发布验收；阶段 B 的 Windows CI 验收已经完成。日志位于 `tmp/ffmpeg-verification/compliance-*.log`，本次二进制哈希以当前 `materials/binary-sha256.txt` 为准，不沿用阶段 A 历史哈希。

## 迁移期间的现有开发基线

现有第三方准备入口的行为与源码构建目录的关系见 [Release 与旧入口](../scripts/README.md#release-与旧入口)，固定归档信息以脚本为准。

第三方准备入口只保留给迁移期间的本地兼容检查，不用于普通 CI、项目 Release、安装包、便携包或长期保存的 FFmpeg 测试产物，也不用于启用面向用户的导出入口。开发与 CI 使用自编译基线；对外分发仍须完成下节要求。

## 分发前完成条件

- 最终产物通过工程检查，可追溯到准确源码、依赖、工具链、参数及补丁。
- 为每个发布二进制准备精确对应的源码、许可证与声明材料及清晰下载入口；维护者复核项目许可证、最终 FFmpeg/x264 组件组合和分发方式所需材料。
- 材料复核后才将运行所需程序/依赖加入 electron-builder.extraResources，置于 ASAR 外；不依赖 PATH、用户预装 FFmpeg 或 Electron 内置 ffmpeg 动态库。
- 实际安装包完成断网导出与主计划性能/内存评审，记录最终发布决定。

手动编码和集成通过不代表分发材料已完成，独立子进程调用也不自动决定项目许可结论。版本、组件、链接方式、依赖、项目许可证、目标平台或打包内容变化时，复核受影响材料与检查，同步主计划及开发检查文档。
