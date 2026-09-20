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

### 获取配置

在应用的配置仓库页面下载并安装配置，默认下载源为官方配置仓库 [GachaSimulate-Configs](<https://github.com/Apprentice-Geo/GachaSimulate-Configs>)；也可以点击「选择本地目录」，指定本地配置目录。配置就绪后，选择统计物品与模拟参数即可运行。

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
