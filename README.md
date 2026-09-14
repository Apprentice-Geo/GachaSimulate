# GachaSimulate

Monte Carlo 抽卡模拟器。TypeScript Compiler 将 YAML 和本次选择的结果 item 编译为 IR，C++ Runtime 执行模拟并输出 GSR；C++ analyzer 为该 item 生成分析数据。

## 快速开始

开发与 CI 基准为 Windows x64：Node.js 24 和 pnpm 11.3.0 使用 Windows 原生环境，C++ 工具链使用 MSYS2 UCRT64。首次启动需要安装依赖与 hook：

```powershell
pnpm install --frozen-lockfile
pnpm run hooks:install
```

按 [Development Checks](docs/DEVELOPMENT_CHECKS.md) 完成 C++ Release install 后启动 Electron：

```powershell
pnpm run dev
```

工具链安装、C++ Debug/Release 构建、静态分析和完整检查命令见 [Development Checks](docs/DEVELOPMENT_CHECKS.md)。不要复用 WSL/Linux 的 `node_modules` 或构建产物。

## Electron

桌面应用有独立的“结果编辑”和“结果可视化”页面；两页共享当前 GSR 会话。应用可以选择已安装配置，以指定 seed 和 threads 运行或取消模拟，打开结果目录，并选择 GSR 编辑展示字段。统计物品列表由 Compiler 从当前 `config.yaml` 的 `items` 读取；表单只按大小写敏感的完整 ID 选择，默认优先 `draw_count`，否则使用第一项。失焦保存生成：

- `<stem>.visualize.json`

sidecar 是独立的 [DisplayConfig v2](docs/DISPLAY_CONFIG.md)，保存版本标记和六个展示字段；分析、result item ID、CDF、termination、total 和 runs 始终从 GSR 重新获取。字段定义、校验与兼容规则由该契约文档维护。

桌面数据位于 `app.getPath("userData")` 下的 `configs/installed/` 与 `results/`。

仓库的 `v*` tag workflow 会构建并测试 Windows 原生程序、生成 NSIS 安装包并发布 GitHub Release；是否已有公开 Release 以仓库 Release 页面为准。

## 可视化与导出

Electron 展示与素材导出共享 `Analysis + DisplayConfig v2` 输入、CDF 视图模型、画面和动画。桌面应用通过独立隐藏 renderer、CDP 逐帧截图和固定 Windows FFmpeg 管道导出 3840×2160、60 FPS 的 MP4 与 PNG，并提供进度、正式取消、部分成功详情与可恢复清理。

Windows 开发准备和宿主检查见 [Development Checks](docs/DEVELOPMENT_CHECKS.md#windows-x64-electron-导出检查)，后续分发阶段见 [Electron 素材导出计划](ELECTRON_EXPORT_PLAN.md)。当前 FFmpeg 仅供开发与 CI，不进入安装包；发布边界见 [FFmpeg 开发使用与分发状态](docs/FFMPEG_DISTRIBUTION.md)。

## 开发检查

模块边界见 [Architecture](ARCHITECTURE.md)，UI 设计原则与交互不变量见 [UI Design](docs/UI_DESIGN.md)，push 前检查见 [Development Checks](docs/DEVELOPMENT_CHECKS.md)。FFmpeg 源码准备、编译和材料打包脚本见 [scripts README](scripts/README.md)。

## 许可证

[GachaSimulate 源码仓库](https://github.com/Apprentice-Geo/GachaSimulate)中的项目自有内容采用 [GNU General Public License v3.0 or later](LICENSE.txt)；第三方组件继续适用各自许可证，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。
