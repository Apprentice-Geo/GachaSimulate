# scripts：FFmpeg 构建与材料收集

本目录负责 Windows x64 下 FFmpeg 的源码准备、MSYS2 UCRT64 自编译、产物检查和专项合规材料打包。流程为：**在线获取源码 → 离线编译 zlib、x264、FFmpeg → 检查并安装产物 → 打包材料 → Release 上传**。

本文是脚本职责与行为的维护入口。应用中的编码器调用、任务生命周期和 UI 不属于这些脚本；分发条件及验证状态见 [FFmpeg 开发使用与分发状态](../docs/FFMPEG_DISTRIBUTION.md)，跨模块检查矩阵见 [Development Checks](../docs/DEVELOPMENT_CHECKS.md#windows-x64-electron-导出检查)，迁移步骤见 [Electron 导出计划](../ELECTRON_EXPORT_PLAN.md)。

## 文件职责

| 文件                                                                     | 职责                                                                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [acquire_ffmpeg_sources.ps1](acquire_ffmpeg_sources.ps1)                 | 在线下载 FFmpeg/zlib 归档并校验哈希，克隆 x264 并切换到固定提交。已有归档和工作树只校验，不自动更新或重置。                                         |
| [build_ffmpeg_win.ps1](build_ffmpeg_win.ps1)                             | 唯一对外构建入口。检查 Windows x64、MSYS2 包和源码身份，调用内部 Bash 构建，检查产物集合、PE 导入和隔离 PATH 运行，再替换安装目录；失败保护旧产物。 |
| [build_ffmpeg_win_ucrt64.sh](build_ffmpeg_win_ucrt64.sh)                 | 内部编译实现，由 PowerShell 传入环境和路径。构建三个组件，收集源码、许可证、参数、日志、链接映射和能力清单，不直接供日常调用。                      |
| [package_ffmpeg_compliance.ps1](package_ffmpeg_compliance.ps1)           | 校验材料与二进制的对应关系，生成版本化 ZIP、清单和校验文件；可记录本次安装包哈希。                                                                  |
| [build_ffmpeg_win.test.mjs](build_ffmpeg_win.test.mjs)                   | 静态检查构建入口不含下载或安装命令，并检查源码锁；不代替实际断网构建验收。                                                                          |
| [package_ffmpeg_compliance.test.ps1](package_ffmpeg_compliance.test.ps1) | 使用已有构建的独立副本验证材料打包、错误输入拒绝、旧包保护、安装包哈希关联和许可证缺口披露。                                                        |
| [prepare_ffmpeg.ps1](prepare_ffmpeg.ps1)                                 | 迁移期间的第三方二进制准备入口，下载或读取固定 Gyan 归档。与自编译共用安装目录，执行后会替换当前产物；使用限制见分发文档。                          |
| [ffmpeg_windows_source_lock.json](ffmpeg_windows_source_lock.json)       | 自编译源码版本、归档名、哈希和 x264 提交的唯一配置来源。更新源码时同步相关检查，不在其他文档维护一份版本锁。                                        |
| [ffmpeg_compliance_README.md](ffmpeg_compliance_README.md)               | 随合规包分发的英文说明模板，包含解包后的离线源码恢复和重建步骤。它面向材料接收者，保持自包含，不依赖仓库文档链接。                                  |

## 环境与运行顺序

从仓库根目录使用 Windows 原生 PowerShell 7 和 Node/pnpm。MSYS2 默认为 `C:\msys64`，工具链采用滚动版本，不在项目内锁定；版本记录用于追溯，不保证以后重建相同二进制。维护者或 CI 在构建前从 UCRT64 shell 准备环境：

```bash
pacman -S --needed bash tar xz make git \
  mingw-w64-ucrt-x86_64-gcc \
  mingw-w64-ucrt-x86_64-binutils \
  mingw-w64-ucrt-x86_64-pkgconf \
  mingw-w64-ucrt-x86_64-nasm
```

所需 CRT、头文件和运行库由包依赖提供。完整包存在性检查以 PowerShell 构建入口为准；构建脚本不安装或升级环境，也不依赖 MSYS2 的 zlib/x264 包。

```powershell
# 在线准备；默认保存到 tmp/ffmpeg-build-inputs
pwsh -NoProfile -File scripts/acquire_ffmpeg_sources.ps1

# 使用固定的本地输入，构建阶段不访问网络
$lock = Get-Content scripts/ffmpeg_windows_source_lock.json -Raw | ConvertFrom-Json
pnpm run build:ffmpeg:win -- `
  -X264Source tmp/ffmpeg-build-inputs/x264 `
  -FfmpegArchive "tmp/ffmpeg-build-inputs/$($lock.ffmpeg.archive_name)" `
  -ZlibArchive "tmp/ffmpeg-build-inputs/$($lock.zlib.archive_name)"

pnpm run test:build:ffmpeg:win
pnpm run package:ffmpeg:compliance
pnpm run test:ffmpeg:compliance
```

源码准备支持 `-OutputDirectory` 和 `-MsysRoot`；构建支持 `-MsysRoot`、三个源码路径和 `-Jobs`（默认逻辑处理器数）。源码也可手动放到本地，但必须匹配源码锁；x264 必须是固定提交的干净 Git 工作树，并保留 `origin/master` 引用，供版本生成和离线 bundle 归档使用。

材料打包支持 `-BuildRoot`（默认 `build/ffmpeg/win32-x64`）、`-OutputDirectory`（默认 `dist`）和可选的 `-Installer <安装包路径>`。记录安装包哈希只表示关联，不自动证明安装包包含该 FFmpeg。

## 编译与产物检查

zlib 从官方归档构建静态库并运行上游检查；x264 构建静态 8-bit 库，关闭 CLI、OpenCL 和共享库。两者只安装到本次临时私有前缀，不写入 MSYS2。FFmpeg 的 pkg-config 搜索限制到该前缀，链接映射确认使用私有 zlib，并拒绝系统 zlib/x264 静态库。

FFmpeg 从 `--disable-everything --disable-autodetect` 开始裁剪，启用 PNG 输入、libx264 编码、MP4 封装及回归探测所需组件，使用 `--enable-gpl`，不启用 nonfree。精确参数以 Bash 实现和本次材料为准。configure 会自动带入依赖，例如 MOV/MP4 所需的 AC3 parser 和 ffmpeg 所需的基础过滤器；这些组件不代表启用了音频编码或网络。

成功产物安装到 `build/ffmpeg/win32-x64`。在同卷 staging 目录完成能力检查后，PowerShell 验证 `bin/` 只有 `ffmpeg.exe`、`ffprobe.exe`，PE 导入只含允许的 Windows 系统 DLL，并复制到临时目录、清空开发工具 PATH 后运行。通过后再替换安装目录；替换失败时恢复旧产物。整个目录被 Git 忽略。

## 材料收集与打包

每次构建的 `materials/` 保存：

- **源码与重建输入**：原始 FFmpeg/zlib 归档、包含版本历史的 `x264.bundle`、源码锁与哈希、补丁清单、构建脚本副本及其 Apache-2.0 许可证、离线重建说明。当前三个组件均无本地源码补丁。
- **环境与构建记录**：所需包版本、完整 MSYS2 包快照、实际工具版本、路径、三套 configure 参数、完整构建与 configure 日志。
- **产物证据**：版本/buildconf、能力清单、二进制 SHA-256、`*-link.map` 中的静态库成员和启动对象，以及 `*-pe-imports.txt` 中的 DLL 依赖。FFmpeg 没有 `-parsers` 命令行选项，parser 清单从本次生成注册表提取，并保留原始 `parser_list.c`。
- **许可证**：三个组件的许可证，以及本次 MSYS2 安装中 `gcc-libs`、`crt`、`winpthreads`、`libwinpthread` 的完整声明目录。不按符号裁剪，也不进一步归档编译器源码或 MSYS2 构建配方；声明集合不表示其中每个库都参与了链接。

缺少运行库声明目录时，构建写入 `license-gaps.txt`，打包显示警告并在 manifest 中披露，允许继续。缺少三个软件的源码、核心许可证、哈希或链接记录则停止打包。打包还校验归档和 bundle 的构建时哈希、二进制与构建记录一致，并拒绝不符合预期的 GPL/libx264 配置或 `--enable-nonfree`。该流程只收集和核对材料，不进行自动法律判定。

输出为 `GachaSimulate-vX.Y.Z-windows-x64-ffmpeg-compliance.zip` 及 `.zip.sha256`，版本来自根目录 `package.json`。ZIP 包含完整材料、关联应用版本/提交/二进制哈希的 `manifest.json` 和内部 `SHA256SUMS`。重建说明模板在打包时更新；二进制构建脚本保留构建时副本。

材料打包测试会在 `tmp/ffmpeg-verification/package-check-*/` 保留独立副本和检查结果，覆盖源码/bundle 或二进制被修改、必要材料缺失、nonfree 配置、失败时旧 ZIP 保留以及声明缺口披露。日常修改后按影响范围执行测试；更改编译行为还须按 Development Checks 运行真实导出集成。

## Release 与旧入口

[Release 工作流](../.github/workflows/release.yml) 负责安装工具链、获取源码、调用构建和材料打包、运行打包检查。附件准备完成后创建 draft Release，上传应用安装包、FFmpeg 材料包和校验文件，全部成功后公开。工作流负责发布，目录内脚本不直接创建 Release。

旧 `prepare:ffmpeg:win` 支持在线下载或 `-- -ArchivePath <zip>` 本地输入，也会检查固定归档哈希、版本和能力，且不回退到 PATH。第三方归档的固定值由 [prepare_ffmpeg.ps1](prepare_ffmpeg.ps1) 维护。迁移进度、第三方产物的使用限制以及 FFmpeg 加入安装包的条件统一见分发文档。
