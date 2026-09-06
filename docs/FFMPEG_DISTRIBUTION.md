# FFmpeg 开发使用与分发状态

## 当前决定与已验证范围

截至 2026-09-06，维护者已确认 Windows x64 自编译路线可行。项目将从固定源码构建 x264 与 FFmpeg，不再保留第三方二进制作为正式分发备选。执行顺序见 [Electron 导出计划](../ELECTRON_EXPORT_PLAN.md)。

人工验证环境为 Windows、MSYS2 UCRT64/Bash、MinGW-w64 GCC、NASM、make 和 pkg-config；FFmpeg 来自固定 tag n9.0.1，x264 使用 MSYS2 预编译包。维护者已验证 libx264 编码、MP4 解码检查，以及 ffmpeg.exe 移到普通目录后在 PowerShell/CMD 中脱离 MSYS2 运行。原记录未提供工具链版本，不能作为最终锁定信息。

人工构建启用 GPL/libx264、FFmpeg 静态库及 pkg-config 静态查询，关闭 debug、doc、ffplay 和 ffprobe；尚未验证 x264 源码构建、自动化、项目 4K 逐帧集成或安装包。后续脚本须生成 ffprobe，手动命令教程由脚本接替，不维护两套构建步骤。

## 目标产物与用途

| 产物 | 用途 | 应用安装包 |
| --- | --- | --- |
| ffmpeg.exe | PNG image2pipe 输入、libx264 编码及 MP4 封装 | 携带 |
| ffprobe.exe | 独立探测程序，开发/CI 检查编码、尺寸、帧率、帧数、像素格式和音轨 | 不携带 |
| 必要运行依赖与声明 | 支持最终链接方式及分发材料 | 按实际依赖与复核结果携带 |

ffmpeg 与 ffprobe 来自同一套 FFmpeg 源码。ffprobe 不参与用户导出，也不替代连续帧像素检查。x264 构建目标是供 FFmpeg 链接的库，不要求分发 x264 命令行工具。

优先裁剪为编码、探测和回归所需组件，具体 configure 参数由脚本和能力验证确定。FFmpeg 自身静态库不等于所有外部依赖均静态链接，须检查最终依赖；开发机运行成功不能替代干净环境验证。

## 自动构建与 CI 待办

1. 固定 x264、FFmpeg 和实际外部依赖的源码版本、提交与归档哈希，记录获取位置、许可证、补丁和修改。实现时选择精确版本，不要求维护者再手动编译 x264。
2. 提交 Windows MSYS2 UCRT64 脚本，按 x264 → FFmpeg/ffprobe 构建；固定并记录工具链/包版本与配置，明确源码、构建、安装和材料目录。可重复执行不默认承诺二进制逐位一致。
3. 输出程序、依赖清单、SHA-256、构建记录及对应源码/许可证材料；记录 -version、-buildconf、-encoders 和输入/输出能力，来源校验失败或能力缺失时终止。
4. Windows CI 构建并执行真实导出检查，后者消费该次构建产物；core/analyzer 同样采用 UCRT64 GCC，项目完整检查迁移到 Windows，移除 Linux preset/job，详见主计划 B。先验证完整构建，再增加覆盖源码、工具链、配置与补丁变化的缓存。
5. 替换现有准备流程并重跑 ExportHost 集成：4K PNG/MP4、60 帧规格与内容、背压、故障、取消及退出。开发/CI 使用 ffprobe，应用不依赖它。
6. 无 MSYS2 开发环境且 PATH 不含开发依赖时验证 Windows 运行；正式产品接入后继续完成主计划的并发、性能/内存和安装包断网验收。

测试和发布以实际二进制哈希关联；重新构建产生不同发布产物时须验证新产物。材料可合并为少量归档，名称由实现确定；文档只链接脚本入口和产物说明，不复制参数清单。

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
