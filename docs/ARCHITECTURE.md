# Architecture

本文档是项目的高层地图，帮助维护者定位代码和理解模块边界。它只记录相对稳定的结构，不作为逐行实现说明；具体配置语法、前端细节和运行语义以各自文档、源码和测试为准。

## 项目概览

GachaSimulate 是一个基于 YAML 配置的 Monte Carlo 抽卡模拟器。项目分为两个主要部分：

- Python 模拟器：加载并校验配置，编译运行上下文，执行单次和批量模拟，输出结果。
- TypeScript 可视化器：读取模拟结果 JSON，计算展示数据，并渲染网页和 CDF 导出素材。

Python 和 TypeScript 通过可视化输入 JSON 连接。Python 负责模拟和结果生成，前端不重新解释抽卡规则。

## 系统地图

```text
YAML 配置
    -> validator
    -> builder
    -> RuntimeContext
    -> engine 执行单次模拟
    -> core 批量聚合 / 保存结果
    -> .npz + visualize JSON
                         -> 前端加载与校验
                         -> normalize / view model
                         -> React 预览或 Remotion 导出
```

## Python 模拟核心

主要代码位于 `src/gachasimulate/`：

- `validator`：在配置进入运行时前检查结构、引用和静态约束。
- `builder`：把 YAML 配置转换为运行时可直接使用的 `RuntimeContext`。
- `runtime`：定义运行上下文、单次运行状态以及 Action、Condition、Rule、Pool、Item 等运行时类型。
- `engine`：使用一个 `RuntimeContext` 执行单次模拟，产生单次运行状态。
- `core`：组织固定 run 数或总抽数目标的批量模拟，处理并行执行、结果聚合和结果保存。
- `cli`：提供命令行入口，负责参数解析和调用批量模拟流程。
- `visualize`：提供 Python 侧的统计或绘图辅助，不属于核心抽卡执行路径。

核心依赖方向是：

```text
配置 -> validator -> builder -> runtime / engine -> core -> 输出
```

运行时不应反向读取 YAML；批量层不应复制单次模拟规则；CLI 不应承载模拟语义。

## 前端可视化

主要代码位于 `src/visualize/`：

- `data/`：读取、校验和规范化可视化输入，并计算 CDF 基础数据。
- `view/`：生成展示模型、统计展示配置和图表布局数据。
- `components/`：React 页面和图表组件，负责渲染与交互。
- `animation/`：网页预览和视频导出共用的动画时间轴与进度计算。
- `remotion/`、`export/`：将同一套展示场景导出为静态图片或视频。
- `types/`：输入数据、规范化数据和展示模型的 TypeScript 类型。
- `styles/`：预览和导出的视觉样式。

前端的数据流是：

```text
visualize JSON -> load / validate -> normalized input -> view model -> scene / export
```

组件不应直接解析原始输入，也不应承担配置校验、CDF 计算或展示规则编排。

## 重要边界

- 配置格式属于输入契约；validator 是配置进入运行时前的边界。
- `RuntimeContext` 描述共享的编译结果；单次运行状态只能保存在 `RuntimeState` 中。
- `engine` 负责单次模拟；`core` 负责批量执行和结果生命周期。
- `.npz` 是 Python 侧结果保存格式；可视化 JSON 是 Python 与前端之间的共享契约。
- 前端只消费可视化输入，不依赖 Python 内部运行时类型或抽卡规则实现。
- 前端组件偏渲染；输入处理、数据计算和视图编排分别位于 `data/`、`view/` 和 `animation/`。

## 稳定不变量

- 配置必须先通过 validator，再由 builder 构建运行时上下文。
- 同一个 `RuntimeContext` 可以被多个 run 使用，但每个 run 必须拥有独立的 `RuntimeState`。
- 配置对象顺序可能具有语义，例如 item 索引和 rule 执行顺序；改变顺序需要视为行为变化。
- 单次模拟必须能够到达 termination；配置不能依赖无法结束的规则或 resolve 循环。
- 修改可视化输入结构时，必须同步更新 JSON schema、TypeScript 类型、校验逻辑和相关测试。
- 修改抽卡执行顺序、配置语义或结果格式时，应同时检查对应文档和跨层测试。

详细信息不放在本文件中：YAML 语法和执行语义见 `docs/YAML_CONFIG_SYNTAX.md`，前端目录和展示维护边界见 `docs/VISUALIZE_FRONTEND_IMPLEMENTATION.md`。
