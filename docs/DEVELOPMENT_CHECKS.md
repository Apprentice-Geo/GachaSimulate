# Development Checks

本文面向 Agent 和贡献者，集中维护环境准备、检查命令与按改动范围选择验证的方法。所有 PowerShell 命令从仓库根目录使用 Windows x64 原生 PowerShell 7 执行；逐项确认退出码，失败后先修复再继续。

## 前置准备

Node.js 24 与 pnpm 11.3.0 使用 Windows 原生安装；C++ 使用 MSYS2 UCRT64 GCC、CMake 和 Ninja，格式化与静态分析使用同一环境的 clang-format 与 clang-tidy。不要复用 WSL/Linux 的依赖或构建产物。MSYS2 采用滚动版本，CI 记录实际版本；工具升级后须完整重跑 C++ 检查。

先在 MSYS2 UCRT64 shell 安装工具：

```bash
pacman -S --needed \
  mingw-w64-ucrt-x86_64-gcc \
  mingw-w64-ucrt-x86_64-cmake \
  mingw-w64-ucrt-x86_64-ninja \
  mingw-w64-ucrt-x86_64-clang \
  mingw-w64-ucrt-x86_64-clang-tools-extra
```

将 `C:\msys64\ucrt64\bin` 放在 Windows `PATH` 前部，再在 PowerShell 中准备项目：

```powershell
# 安装锁定依赖与仓库 pre-commit hook
pnpm install --frozen-lockfile
pnpm run hooks:install

# Electron 开发前：Release 构建、测试、安装与隔离 PATH 冒烟
pnpm run check:cpp:release

# 启动 Electron 桌面应用
pnpm run dev
```

Release 检查将 core/analyzer 及运行时依赖安装到 `build/native/bin`。导出集成检查与 Windows 打包另需按 [scripts README](<../scripts/README.md#环境与运行顺序>) 准备固定源码构建的 FFmpeg 及材料。

## 标准检查命令

### C++

```powershell
# 全部 C++ 检查；下列分步入口用于单独定位失败
pnpm run check:cpp

pnpm run check:cpp:format   # clang-format
pnpm run check:cpp:debug    # Debug 构建与 CTest
pnpm run check:cpp:tidy     # clang-tidy，须先完成 Debug 检查
pnpm run check:cpp:release  # Release 构建、CTest、安装与隔离 PATH 冒烟
```

`check:cpp:tidy` 消费 Windows Debug preset 生成的 GCC `compile_commands.json`。发布编译器始终是 GCC；clang-tidy 只做静态分析。

### Node、Electron 与仓库质量

本地需先安装 `actionlint`；CI 使用 workflow 声明的固定版本，并将 workflow 检查作为其它 job 的前置条件。

```powershell
# GitHub Actions workflow、hook 自测与仓库内 Markdown 链接
actionlint
pnpm run test:pre-commit
pnpm run test:markdown:links

# 第三方许可证、格式、静态规则与类型
pnpm run test:application-licenses
pnpm run format:check
pnpm run lint
pnpm run typecheck

# Compiler 与配置仓库协议
pnpm run test:packages

# 配置安装、模拟/分析进程、IPC、结果会话与 sidecar
pnpm run test:simulation

# 可视化输入契约、CDF 与导出宿主/任务行为
pnpm run test:visualize:cdf
pnpm run test:electron-export

# 真实 Electron 布局与 DOM/SVG 几何
pnpm run test:electron-layout

# 普通 production build；不得启用导出像素探针
pnpm run build
```

Electron 和相关测试入口会在使用前构建所需 package；package 的 `dist/` 不提交。

### Windows 打包与格式修复

打包前须完成 C++ Release install 和固定 FFmpeg 构建及材料检查。发布流程统一见 [scripts README](<../scripts/README.md#发布流程>)。

```powershell
# 生成 NSIS 安装包并检查包内原生程序、许可证和隔离 PATH 运行
pnpm run package:win
pnpm run test:package:win

# 仅在格式检查失败时执行，再重新运行 format:check
pnpm run format
```

## 按影响范围选择

以下名称对应上述命令；专项检查和截图命令见后续章节。

- YAML：`test:packages`、typecheck；若改变 IR，继续执行 IR 对应检查。
- IR：`test:packages`、`test:simulation` 中的 native pipeline、C++ Debug/Release 检查和 typecheck。
- 配置仓库 index、manifest 或包文件集合：`test:packages`、`test:simulation` 和 typecheck。
- C++ Runtime、GSR 或 Analysis：C++ 完整检查，覆盖格式、静态分析、Debug/Release CTest、安装和冒烟。
- Electron IPC、配置扫描、模拟/分析进程生命周期或 sidecar：`test:simulation`、typecheck、lint、build。
- [Analysis](<ANALYSIS.md>) 或 [DisplayConfig](<DISPLAY_CONFIG.md>) 输入契约：同步核对 Schema、semantic validator、类型和 fixture，执行 `test:visualize:cdf`、`test:simulation`、typecheck 和 build。
- CDF、marker、统计展示或动画：`test:visualize:cdf`、`test:electron-layout` 和 build；导出改动另跑下述宿主集成检查。
- Electron 桌面布局：`test:electron-layout`、`test:simulation`、`test:visualize:cdf`、typecheck、lint、format:check 和 build，并查看大小窗口截图。
- Electron 导出 renderer、逐帧协议、CDP、FFmpeg 或输出提交：`test:visualize:cdf`、`test:electron-export`、typecheck、lint、build 和下述宿主集成检查。
- 桌面导出入口、格式/文件名、目标选择、覆盖、进度、终态或阻塞清理交互：执行导出范围检查，追加 `test:electron-layout`，并查看下述导出状态截图。
- npm 生产依赖、字体、原生第三方组件或 Electron 打包资源：`test:application-licenses`、`package:win` 和 `test:package:win`。
- 文档：核对命令与完成状态，执行 `test:markdown:links`；跨层契约变更仍按对应范围验证。

## Windows x64 Electron 导出检查

准备固定 FFmpeg 后，先验证普通构建，再生成仅供集成检查的像素探针构建。探针通过编码当前帧号验证 CDP 截图的逐帧连续性；集成检查在临时目录生成 PNG、MP4、harness 和故障注入产物，并使用同包 `ffprobe.exe` 检查视频规格。

以下命令在未设置两个探针/集成环境变量的 PowerShell 会话中执行：

```powershell
# 共享契约、宿主单元测试与普通 production build
pnpm run test:visualize:cdf
pnpm run test:electron-export
pnpm run build

try {
  # 构建带逐帧像素探针的测试产物
  $env:GACHASIMULATE_EXPORT_FRAME_PROBE = "1"
  pnpm run build
  if ($LASTEXITCODE -ne 0) { throw "导出探针构建失败" }

  # 强制执行真实 ExportHost 集成检查
  $env:GACHASIMULATE_REQUIRE_EXPORT_HOST_INTEGRATION = "1"
  pnpm run test:electron-export:integration
  if ($LASTEXITCODE -ne 0) { throw "导出宿主集成检查失败" }
} finally {
  # 即使检查失败，也清理测试环境变量
  Remove-Item Env:GACHASIMULATE_EXPORT_FRAME_PROBE -ErrorAction SilentlyContinue
  Remove-Item Env:GACHASIMULATE_REQUIRE_EXPORT_HOST_INTEGRATION -ErrorAction SilentlyContinue
}

# 后续运行或打包前，重新生成不带探针的普通产物
pnpm run build
```

正式 production build 不得设置 `GACHASIMULATE_EXPORT_FRAME_PROBE`；清理环境变量不会自动移除已有构建产物中的探针。

## Electron 布局与截图检查

布局契约以 [UI Design](<UI_DESIGN.md>) 为依据，共享画面与逐帧语义见 [Architecture](<../ARCHITECTURE.md#可视化与导出>)。`test:electron-layout` 覆盖四种窗口尺寸下的空间分配、滚动、文字缩放、固定画布适配与 DOM/SVG 几何；`capture:ui` 只生成截图，供 Agent 检查真实渲染的视觉层级、密度、裁切和遮挡，不能替代布局测试。

布局契约及其测试必须谨慎修改：不得为让测试通过而删除断言、放宽容差、缩减尺寸或 fixture 覆盖；只有明确改变设计规格时才同步调整对应断言，并保留未受影响的回归保护。断言暴露既有布局问题时，应修复或报告问题。

```powershell
# 截取全部内置场景，输出到 tmp/ui-captures/
pnpm run capture:ui

# 按改动范围选择导出交互场景
pnpm run capture:ui electron/result-export-format
pnpm run capture:ui electron/result-export-overwrite
pnpm run capture:ui electron/result-export-started
pnpm run capture:ui electron/result-export-progress
pnpm run capture:ui electron/result-export-partial-failure
pnpm run capture:ui electron/result-export-cleanup-blocked

# 同时执行四种尺寸布局测试并保存 layout-*.png；在未设置该变量的会话中执行
try {
  $env:GACHASIMULATE_LAYOUT_CAPTURE = "1"
  pnpm run test:electron-layout
  if ($LASTEXITCODE -ne 0) { throw "Electron 布局检查失败" }
} finally {
  Remove-Item Env:GACHASIMULATE_LAYOUT_CAPTURE -ErrorAction SilentlyContinue
}
```
