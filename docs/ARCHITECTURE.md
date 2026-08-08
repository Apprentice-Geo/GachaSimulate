# Architecture

本文档是 GachaSimulate 的高层地图，帮助维护者判断某类改动应从哪里开始。它只记录不易频繁变化的模块、边界和决策；具体行为以源码、测试及专项文档为准。

## 项目概览

GachaSimulate 使用 YAML 描述抽卡规则，通过模拟核心执行 Monte Carlo 模拟，并生成 `.npz` 结果和 `_visualize.json`。桌面应用负责配置选择、任务控制和结果加载；平台无关的可视化层负责校验结果输入、计算展示模型和导出画面。

系统的稳定数据流是：

```text
YAML 配置
    -> 模拟核心
    -> .npz + visualize JSON
                         -> 可视化输入校验
                         -> normalized data / view model
                         -> Electron 展示或素材导出
```

## 代码地图

### 模拟核心

`src/gachasimulate/` 是当前 Python 模拟核心：

- `validator` 和 `builder` 负责把 YAML 配置校验并编译为运行期结构。
- `runtime` 和 `engine` 定义并执行单次模拟语义。
- `core` 负责批量执行、并行聚合、进度和结果生命周期。
- `cli` 是外部调用边界，供命令行用户和桌面应用启动模拟。

`configs/` 保存项目配置和开发预置，`tests/` 保护模拟语义与输入契约，`benchmark/` 测量完整批量模拟路径。

### Electron 桌面层

Electron 按运行权限分为三层：

- `src/main/` 拥有操作系统能力，负责用户数据目录、配置扫描、文件对话框和模拟子进程。
- `src/preload/` 只向 Renderer 暴露明确的桌面 API。
- `src/renderer/` 负责桌面页面、表单和任务反馈，不直接使用 Node.js 能力。

跨进程共享的请求和事件类型位于 `src/shared/`。Electron 通过 CLI 和 JSONL 事件协议调用模拟核心，不依赖 Python 内部类型。

### 可视化与导出

`src/visualize/` 是平台无关的可视化层，包含输入校验、数据规范化、视图模型、画面组件、动画和导出实现。Electron Renderer 组合这些能力，但桌面导航、文件系统和任务管理不进入该目录。

素材导出是长期能力。独立浏览器入口目前用于开发和调试，属于可移除的过渡能力，不是架构不变量。

可视化输入 schema 位于 `docs/schemas/`，它是模拟输出与 TypeScript 消费方之间的共享契约。

## 长期边界与决策

- 模拟语义只存在于模拟核心。Electron 和可视化层不得复制抽卡规则、termination 或 resolve 语义。
- 桌面端通过独立进程协议调用模拟核心。这一边界允许未来用编译语言替换当前 Python 实现，而不要求 TypeScript 承担模拟任务。
- 配置仓库与应用代码仓库长期分离，以便社区独立贡献配置，并让配置更新不受应用版本发布节奏约束。配置仓库功能当前尚未实现。
- Electron main 是操作系统信任边界；Renderer 不直接接触文件系统、任意 IPC channel 或子进程能力。
- `src/visualize/` 保持平台无关，必须继续支持结果展示和素材导出；任何宿主特有的交互留在宿主层。

## 稳定不变量

- 配置必须先通过 validator，再由 builder 构建运行时上下文。
- 同一个 `RuntimeContext` 可以被多个 run 使用，但每个 run 必须拥有独立的 `RuntimeState`。
- 配置对象顺序可能具有语义，例如 item 索引和 rule 执行顺序；改变顺序应视为行为变化。
- 单次模拟必须能够到达 termination；配置不能依赖无法结束的规则或 resolve 循环。
- `engine` 负责单次模拟，`core` 负责批量执行；CLI 和桌面层不承载模拟语义。
- `.npz` 与 `_visualize.json` 是同一次结果保存的成对产物。
- 修改可视化输入结构时，必须同步更新 JSON schema、TypeScript 类型、校验逻辑和相关测试。

## 横切关注点

来自 YAML、manifest、Renderer IPC 和可视化 JSON 的数据都跨越信任边界，必须在拥有该边界的层重新校验。模拟任务的启动、取消和应用退出共同拥有子进程生命周期，不能遗留 worker。共享契约发生变化时，应同时检查生产方、消费方和跨层测试。

YAML 语法和执行语义见 `docs/YAML_CONFIG_SYNTAX.md`；可视化维护边界见 `docs/VISUALIZE_FRONTEND_IMPLEMENTATION.md`；检查矩阵见 `docs/DEVELOPMENT_CHECKS.md`。
