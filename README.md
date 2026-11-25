# GachaSimulate

可配置的 Monte Carlo 抽卡模拟与结果可视化桌面工具，用于分析抽卡规则下的物品数量分布、分位数与终止原因。

## 亮点

- 使用 YAML 描述抽卡规则，自由选择需要统计的物品。
- C++ 模拟核心，支持多线程与固定随机种子。
- 集成配置安装、模拟运行、结果编辑与分布可视化。
- 支持导出 4K PNG 图片与 60 FPS MP4 视频。

## 快速开始

### 下载安装

从 [GitHub Releases](<https://github.com/Apprentice-Geo/GachaSimulate/releases>) 下载 Windows x64 安装包，安装后启动应用。

### 运行第一次模拟

1. 打开「配置仓库」，选择配置并安装。默认来源为 [GachaSimulate-Configs](<https://github.com/Apprentice-Geo/GachaSimulate-Configs>)。已有本地配置时，也可以点击「选择本地目录」。
2. 进入「运行模拟」，选好配置、终止条件和统计物品，设置模拟次数后点击「启动模拟」。
3. 状态变为「已完成」后，点击「查看本次结果」进入结果可视化。需要找到保存的 GSR 文件时，点击「打开结果目录」。

在结果画面点击「编辑」可以修改标题、单位和说明等文字。离开字段时自动保存，点击「完成编辑」返回展示。「图表预览」可单独查看静态分布图。

侧栏底部的「设置」可以切换工作台主题，查看软件版本、许可证和项目链接。结果画面和导出素材使用深色主题。

### 从源码运行

开发基准为 Windows x64。先按 [Development Checks](<docs/DEVELOPMENT_CHECKS.md#前置准备>) 准备 Node.js、pnpm 与 MSYS2 UCRT64 工具链，然后在仓库根目录执行：

```powershell
# 安装依赖
pnpm install --frozen-lockfile

# 构建、检查并安装原生模拟与分析程序
pnpm run check:cpp:release

# 启动桌面应用
pnpm run dev
```

## 许可证

项目自有内容采用 [GNU General Public License v3.0 or later](<LICENSE.txt>)；第三方组件继续适用各自许可证，详见 [第三方声明](<THIRD_PARTY_NOTICES.md>)。
