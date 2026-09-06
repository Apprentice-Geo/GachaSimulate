# FFmpeg 开发使用与分发状态

## 当前决定与已验证范围

截至 2026-09-07，Windows x64 离线自编译入口已经完成本机连续两次源码构建及完整 ExportHost 集成验证。项目从固定源码构建 x264 与 FFmpeg，不把第三方二进制作为正式分发备选。执行顺序见 [Electron 导出计划](../ELECTRON_EXPORT_PLAN.md)。

本次验证环境为 Windows x64、Windows 原生 Node/pnpm、MSYS2 UCRT64/Bash、MinGW-w64 GCC、NASM、make 和 pkgconf；x264 与 FFmpeg 均来自下述固定源码，zlib 使用 UCRT64 静态库。环境准备先完成 MSYS2 全量滚动升级和缺失工具安装，构建脚本本身保持离线。

阶段 A 已完成，本机编译、失败保护、PE 依赖、隔离 PATH 运行和导出检查已通过。干净 Windows x64 断网验收尚未执行，后置到阶段 B 的 CI/CD 工作流改造，不再作为阶段 A 的完成条件；本机验证不表示安装包或分发验收通过。

## 目标产物与用途

| 产物 | 用途 | 应用安装包 |
| --- | --- | --- |
| ffmpeg.exe | PNG image2pipe 输入、libx264 编码及 MP4 封装 | 携带 |
| ffprobe.exe | 独立探测程序，开发/CI 检查编码、尺寸、帧率、帧数、像素格式和音轨 | 不携带 |
| 必要运行依赖与声明 | 支持最终链接方式及分发材料 | 按实际依赖与复核结果携带 |

ffmpeg 与 ffprobe 来自同一套 FFmpeg 源码。ffprobe 不参与用户导出，也不替代连续帧像素检查。x264 构建目标是供 FFmpeg 链接的库，不要求分发 x264 命令行工具。

优先裁剪为编码、探测和回归所需组件，具体 configure 参数由脚本和能力验证确定。FFmpeg 自身静态库不等于所有外部依赖均静态链接，须检查最终依赖；开发机运行成功不能替代干净环境验证。

## 离线构建入口

唯一构建入口为：

```powershell
pnpm run build:ffmpeg:win -- `
  -X264Source D:\sources\x264 `
  -FfmpegArchive D:\sources\ffmpeg-9.0.1.tar.xz
```

可选参数 `-MsysRoot` 默认为 `C:\msys64`，`-Jobs` 默认为逻辑处理器数。脚本不准备环境或源码，不执行包安装/更新、源码网络操作或下载；缺少输入时会报告路径和预期值。源码固定值的单一来源是 `scripts/ffmpeg_windows_source_lock.json`：

- x264：VideoLAN 提交 `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`，必须是无已跟踪或未跟踪改动的 Git 工作树。
- FFmpeg：官方 `ffmpeg-9.0.1.tar.xz`，SHA-256 `cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635`。
- zlib：使用构建环境已有的 UCRT64 静态库 `/ucrt64/lib/libz.a`，不会安装到 MSYS2，也不会从源码重建。

x264 构建为静态 8-bit 库，关闭 CLI、OpenCL 和共享库，安装到本次临时私有前缀。FFmpeg 静态链接并从 `--disable-everything --disable-autodetect` 开始，显式启用 ffmpeg/ffprobe、PNG/H.264/libx264、image2pipe/MOV/MP4、MP4、file/pipe、PNG/H.264 parser，以及 buffer/buffersink/format/scale/swscale；精确参数保存在构建脚本和每次材料中。

FFmpeg 9.0.1 的 configure 还会自动选择依赖：MP4 muxer 选择 MOV muxer，后者选择 AC3 parser；ffmpeg 选择 aformat/anull/atrim/crop/hflip/null/rotate/transpose/trim/vflip 等基础过滤器，buffer/sink 也包含音频端点。因此最终 parser 包含 ac3/h264/png，muxer 包含 mov/mp4；这些依赖不意味着启用了音频编解码器或网络协议。完整能力以材料清单为准。

成功产物安装到 `build/ffmpeg/win32-x64`。脚本先在同卷 staging 目录完成能力、PE 导入和清空开发工具 PATH 的运行检查，再事务式替换目标；任何失败都会保留替换前产物。`bin/` 只允许 `ffmpeg.exe` 和 `ffprobe.exe`，PE 导入只允许 Windows 系统 DLL。

## MSYS2 UCRT64 环境

MSYS2 和工具链采用滚动仓库中的当前版本，不在项目内锁定。默认布局为 MSYS2 `C:\msys64`、MSYS 工具 `/usr/bin`、UCRT64 工具和静态库 `/ucrt64/bin`、`/ucrt64/lib`。维护者或 CI/CD 可在构建前从 UCRT64 shell 准备环境；该操作不属于离线构建脚本：

```bash
pacman -S --needed bash tar xz make git \
  mingw-w64-ucrt-x86_64-gcc \
  mingw-w64-ucrt-x86_64-binutils \
  mingw-w64-ucrt-x86_64-pkgconf \
  mingw-w64-ucrt-x86_64-nasm \
  mingw-w64-ucrt-x86_64-zlib
```

构建入口只校验所需包、命令和静态 zlib 是否存在，不安装、更新或限制其版本。每次成功构建都会把所需包的实际版本、完整 MSYS2 包快照和工具版本写入 `materials/`，因此二进制可以追溯到本次环境。工具链滚动后可能生成不同二进制，必须重新执行能力、PE 依赖、隔离运行和项目集成检查；记录版本提供可追溯性，不等于保证以后可以重建相同二进制。

CI/CD 在调用入口前负责：准备可用的 MSYS2 UCRT64 环境；准备固定提交且干净的 x264 工作树；把官方 FFmpeg 归档放到本地并预校验 SHA-256。维护者可把 MSYS2、工作树和归档放到任意本地路径，再分别使用 `-MsysRoot`、`-X264Source` 和 `-FfmpegArchive` 指定。构建阶段可以断网，输入会被复用且不会被修改。

## 构建材料与阶段 A 验收

每次成功构建的 `materials/` 包含源码锁、源码身份/哈希、源码许可证、空补丁清单、所需包的实际版本、完整 MSYS2 包快照、实际工具版本、安装路径、两套 configure 参数、完整构建日志、版本/buildconf、能力清单、PE 导入和二进制 SHA-256。材料用于后续复核，不代表可重复构建、安装包或许可证审核已经通过。

FFmpeg 9.0.1 没有 `-parsers` 命令行选项；`parsers.txt` 从本次编入 libavcodec 的生成注册表提取，原始 `parser_list.c` 一并保留。其它能力清单来自本次生成的 ffmpeg.exe。

静态禁网检查：

```powershell
pnpm run test:build:ffmpeg:win
```

在准备完整环境后，应连续运行构建入口两次，并分别保存材料和哈希；不要求二进制逐位一致。两次均须检查 `-version`、`-buildconf`、能力清单、失败时旧产物保护，并按 [Development Checks](DEVELOPMENT_CHECKS.md#windows-x64-electron-导出检查) 运行 ExportHost 单元、production build、探针 build 和真实集成检查。干净 Windows x64 环境中的断网重做与证据归档后置到阶段 B，具体执行要求见 [Electron 导出计划](../ELECTRON_EXPORT_PLAN.md)。

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

实际工具记录包括 GCC 16.2.0、ld 2.47.20260726、make 4.4.1、pkgconf 3.0.5、NASM 3.02、Git 2.55.0 和 Bash 5.3.15；完整包版本见各次 JSON 快照。这些是本次构建记录，不是工具版本约束。干净 Windows x64 断网验收作为阶段 B 后置事项，尚未执行。

阶段 B 才会修改 CI、替换现有 Gyan 准备入口、迁移平台基线或接线应用打包。

## 迁移期间的现有开发基线

替换前，`pnpm run prepare:ffmpeg:win` 仍准备固定 Gyan 归档，也支持 `-- -ArchivePath <zip>` 本地副本；校验后安装到忽略的 `build/ffmpeg/win32-x64`，无 PATH 回退：

- 归档：ffmpeg-9.0.1-essentials_build.zip，来源 Gyan GitHub Release。
- SHA-256：fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9。
- FFmpeg 提交：bf1b838f2a；同包包含 ffmpeg、ffprobe 与 libx264 能力。

第三方基线仅供内部开发与临时 Windows CI，不进入项目 Release、安装包、便携包或长期保存的 FFmpeg 测试产物，也不用于启用面向用户的导出入口。自编译基线可用于开发态产品接入，对外分发须完成下节要求。替换后删除本节具体第三方信息，同步准备脚本、CI 和 Development Checks。

## 分发前完成条件

- 最终产物通过工程检查，可追溯到准确源码、依赖、工具链、参数及补丁。
- 为每个发布二进制准备精确对应的源码、许可证与声明材料及清晰下载入口；维护者复核项目许可证、最终 FFmpeg/x264 组件组合和分发方式所需材料。
- 材料复核后才将运行所需程序/依赖加入 electron-builder.extraResources，置于 ASAR 外；不依赖 PATH、用户预装 FFmpeg 或 Electron 内置 ffmpeg 动态库。
- 实际安装包完成断网导出与主计划性能/内存评审，记录最终发布决定。

手动编码和集成通过不代表分发材料已完成，独立子进程调用也不自动决定项目许可结论。版本、组件、链接方式、依赖、项目许可证、目标平台或打包内容变化时，复核受影响材料与检查，同步主计划及开发检查文档。
