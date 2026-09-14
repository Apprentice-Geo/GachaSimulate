# Development Checks

本文列出的标准检查命令和 CI 基准从 Windows x64 原生 PowerShell 7 执行。Node/pnpm 使用 Windows 原生安装；C++ 使用 MSYS2 UCRT64 GCC、CMake 和 Ninja，格式化与静态分析使用 UCRT64 clang-format 与 clang-tidy。MSYS2 工具链采用滚动版本，CI 记录每次实际版本；工具升级后须完整重跑 C++ 检查。

## 前置准备

先在 MSYS2 UCRT64 shell 安装工具：

```bash
pacman -S --needed \
  mingw-w64-ucrt-x86_64-gcc \
  mingw-w64-ucrt-x86_64-cmake \
  mingw-w64-ucrt-x86_64-ninja \
  mingw-w64-ucrt-x86_64-clang \
  mingw-w64-ucrt-x86_64-clang-tools-extra
```

将 `C:\msys64\ucrt64\bin` 放在 Windows `PATH` 前部。在仓库根目录使用 Windows 原生 Node/pnpm 安装依赖：

```powershell
pnpm install --frozen-lockfile
```

Electron 开发前必须完成 C++ Release install：

```powershell
pnpm run check:cpp:release
```

Release 检查会安装 core/analyzer 到 `build/native/bin`，并清空开发工具 PATH 后执行模拟与分析冒烟，防止漏带运行时依赖。

## C++ 完整检查

```powershell
pnpm run check:cpp
```

需要单独定位失败时可分步执行：

```powershell
pnpm run check:cpp:format
pnpm run check:cpp:debug
pnpm run check:cpp:tidy
pnpm run check:cpp:release
```

`check:cpp:tidy` 消费 Windows Debug preset 生成的 GCC `compile_commands.json`，因此须先完成 Debug 检查。发布编译器始终是 GCC；clang-tidy 只做静态分析。

## Node/Electron 完整检查

```powershell
pnpm run test:application-licenses
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:packages
pnpm run test:simulation
pnpm run test:visualize:cdf
pnpm run test:electron-export
pnpm run test:electron-layout
pnpm run build
pnpm run package:win
pnpm run test:package:win
```

Package 的 `dist/` 不提交；Electron 和相关测试入口会在使用前构建所需 package。

## 按影响范围选择

- YAML：`test:packages` 中的 Compiler 测试和 typecheck；若改变 IR，继续执行 IR 对应检查。
- IR：`test:packages` 中的 Compiler 测试、`test:simulation` 中的 native pipeline、C++ Debug/Release CTest 和 typecheck。
- 配置仓库 index、manifest 或包文件清单协议：`test:config-repository-contract`、`test:packages`、`test:simulation` 中的下载/安装行为测试和 typecheck。
- C++ Runtime、GSR 或 Analysis：format/tidy、Debug/Release CTest、Release install 和冒烟。
- Electron IPC、配置扫描、模拟/分析进程生命周期或 sidecar：`test:simulation`、typecheck、lint、build。
- [Analysis](ANALYSIS.md) 或 [DisplayConfig](DISPLAY_CONFIG.md) 输入契约：同步核对 JSON Schema、semantic validator、TypeScript 类型和共享 fixture，并执行 `test:visualize:cdf`、`test:simulation`、typecheck 和 build。
- CDF、marker、统计展示或动画：`test:visualize:cdf`、`test:electron-layout` 和 build；导出改动另跑代表性实际 export。
- Electron 桌面布局：`test:electron-layout`、`test:simulation`、`test:visualize:cdf`、typecheck、lint、format:check 和 build；查看大小窗口真实截图，确认空间利用率、文字与控件密度及内部滚动。固定画布的适配不应受桌面布局影响。
- Electron 导出 renderer、逐帧协议、CDP、FFmpeg 或输出提交：`test:visualize:cdf`、`test:electron-export`、typecheck、lint 和 build；Windows x64 继续执行下述正式宿主集成检查。
- npm 生产依赖、字体、原生第三方组件或 Electron 打包资源：`test:application-licenses`、`package:win` 和 `test:package:win`；安装包检查会核对项目与静态第三方材料、npm 清单以及 Electron/Chromium 声明。
- 桌面导出入口、格式/文件名、目标选择、覆盖、进度、终态或阻塞清理交互：在上一项基础上执行 `test:electron-layout`，并用 `capture:ui` 检查 format、overwrite、started、progress、partial-failure 和 cleanup-blocked 场景。系统原生目录选择器本身仍按人工验收项检查。
- 仅文档：检查命令、链接和完成状态；跨层状态文档仍按对应范围验证。

## Windows x64 Electron 导出检查

先按 [scripts README](../scripts/README.md#环境与运行顺序) 从固定源码构建 FFmpeg，并执行对应的材料检查。旧第三方准备入口仅保留作迁移历史兼容，不用于 CI。当前迁移状态及分发限制见 [FFmpeg 开发使用与分发状态](FFMPEG_DISTRIBUTION.md)。

资产准备完成后，先验证共享契约、宿主单元测试和普通 production build，再生成只供集成检查使用的像素探针 build 并直接驱动 `ExportHost`：

```powershell
pnpm run test:visualize:cdf
pnpm run test:electron-export
pnpm run build
$env:GACHASIMULATE_EXPORT_FRAME_PROBE = "1"
pnpm run build
$env:GACHASIMULATE_REQUIRE_EXPORT_HOST_INTEGRATION = "1"
pnpm run test:electron-export:integration
```

正式 production build 不得设置 `GACHASIMULATE_EXPORT_FRAME_PROBE`。集成检查只在临时目录生成 PNG、MP4、harness 和故障注入产物，并使用同包 `ffprobe.exe` 检查视频规格。

该准备流程和 Windows CI 只用于技术验证，不表示 FFmpeg 已获准随应用分发。当前 `electron-builder` 配置不携带 FFmpeg；不得把 `build/ffmpeg` 加入安装包。发布阻塞、已知风险和解除条件见 [FFmpeg 开发使用与分发状态](FFMPEG_DISTRIBUTION.md)。

## Electron 人工验收

视觉语言、布局与交互不变量以 [UI Design](UI_DESIGN.md) 为验收依据；共享场景与逐帧语义见 [Architecture](../ARCHITECTURE.md#可视化与导出)。修改设计规格时，同步更新相关布局断言与验收要求。

UI 回归分工：`capture:ui` 只准备场景并输出截图；布局、滚动、固定结果画布适配和真实 DOM/SVG 几何由 `pnpm run test:electron-layout` 独立检查。桌面 UI 不使用全局 zoom；内部滚动区域必须有明确滚动所有者，panel 标题不能放入内容滚动容器。测试使用实际 CSS viewport 和 DOM 坐标，不做桌面 zoom 坐标换算。CDF compact/default 同时检查纯几何参数与最终 DOM。结果字段只在失焦时保存。

布局测试分别在 2560×1440、1600×900、1280×720 和 2560×900 验证 Page 填满 Main、Workbench 与 Header 衔接及填满剩余空间、双栏边界对齐、Preview 填满父布局分配区域，以及模拟轨迹填满控制正文剩余高度。跨尺寸检查基础字号从 18px 到 27px 连续变化，其它字号、控件、图标和主要间距相对原有比例同步放大 15%，并检查侧边栏约 6.9% 占比。宽而矮的 2560×900 下检查字段、操作与导航可访问。低高度下正文可滚动，轨迹不被压扁或裁切。长列表 fixture 使用足够多的项目触发大窗口滚动；少量内容仍保留分区高度。配置仓库按扣除边框、内边距后的内容高度验证 7:3 分配；几何比较允许 1 个 CSS 像素的取整误差（测试 deviceScaleFactor 为 1）。新增断言暴露既有布局问题时，应报告或修复布局，不得放宽断言迁就越界或收缩行为。布局原则与各页滚动所有者以 [UI Design](UI_DESIGN.md#桌面工作空间) 为准。

需要同时留存布局测试四个尺寸的截图时，在 PowerShell 设置 `$env:GACHASIMULATE_LAYOUT_CAPTURE = "1"` 后执行 `pnpm run test:electron-layout`。截图写入 `tmp/ui-captures/layout-*.png`；完成后执行 `Remove-Item Env:GACHASIMULATE_LAYOUT_CAPTURE`。普通 `capture:ui` 继续提供原有场景截图。

- 固定次数能运行，threads 边界正确，任务互斥。
- 取消、窗口关闭和应用退出后无残留 core/analyzer；失败任务不留下临时 IR 或半成品 GSR。
- 完成后能打开结果目录并选择 GSR。
- 启动前选择的任意合法 result item 都能分析；损坏/超限 GSR 和 analyzer 失败显示上下文错误。
- 六个展示字段失焦后原子保存对应 DisplayConfig sidecar；重新打开只恢复展示配置，分析字段来自 GSR。
- 非法 sidecar 不被自动覆盖；结果编辑和结果可视化页面可用键盘操作并共享 GSR 选择。
- 素材导出系统目录选择器以主窗口为 parent；取消/返回、中文与空格目录、统一覆盖以及 MP4/PNG/双格式实际产物正确。使用屏幕阅读器复核导出入口禁用原因、模态标题与焦点播报。
- 取消确认后保持阻塞直到唯一终态；部分成功列出已保存与失败格式。注入文件占用时清理壳不能通过 Esc、遮罩或导航绕过，重复重试与退出后的单次后台清理不留下可避免的 FFmpeg、窗口、partial 或 backup。

格式失败时执行 `pnpm run format`；其它失败按首个具体错误修复，不用批量改动掩盖问题。
