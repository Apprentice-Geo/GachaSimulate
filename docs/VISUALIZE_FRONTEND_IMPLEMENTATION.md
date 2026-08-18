# Visualize Frontend Implementation

本文档记录 `src/visualize/` 的稳定职责、设计决策和维护边界。具体组件、动画时长和样式数值以源码为准，不在这里维护逐文件镜像。

## 定位

`src/visualize/` 是平台无关的结果可视化层。它把 `AnalysisV2 + DisplayConfig v1` 转换为经过校验的展示模型，供 Electron 和素材导出使用。Node.js 文件系统、Remotion bundler/renderer 和导出进程入口位于 `src/export/`，只依赖本层，不被本层反向依赖。

素材导出是长期保留能力。当前独立浏览器入口用于开发和调试，不保证长期存在。

Electron 的导航、模拟表单、GSR 对话框、analyzer 进程、结果编辑页和结果可视化页属于 `src/renderer/`、`src/preload/` 与 `src/main/`，不得进入 `src/visualize/`。反过来，`src/visualize/` 不依赖 Electron 或 Node.js API。

## 数据流

稳定的数据流是：

```text
unknown input
    -> schema / business validation
    -> normalized input
    -> view model
    -> shared scene
    -> Electron display or Remotion export
```

原始输入不能绕过校验直接进入组件。组件消费 normalized data 或 view model，不承担 schema 校验、CDF 计算或展示规则编排。

Electron 的结果编辑页和结果可视化页共享当前 GSR 会话。main 调用 C++ analyzer 并校验 Analysis v2；编辑页只保存 DisplayConfig v1，可视化页用 `AnalysisV2 + DisplayConfig` 生成共享视图模型。旧完整 JSON 不做隐式兼容。

## 模块地图

- `data/`：输入校验、规范化和 CDF 基础数据。
- `view/`：展示模型、统计配置和与画面有关的布局计算。
- `components/`：共享画面与交互组件，保持偏渲染。
- `animation/`：交互展示和逐帧导出共用的时间轴与进度计算。
- `styles/`：共享设计 token、画面样式和宿主外壳样式。
- `remotion/`：复用共享场景的 Remotion composition。
- `src/export/`：位于可视化层之外的 Node.js 素材导出宿主。
- `types/`：原始输入、normalized data 和 view model 类型。

重要符号包括 `AnalysisV2`、`DisplayConfig`、`build_cdf_view_model` 和 `VisualizeScene`。需要定位具体实现时，优先搜索这些符号及上述模块，而不是依赖本文档中的文件清单。

## 设计决策

### 展示与导出共享

Electron 展示和素材导出复用同一套输入处理、视图模型、画面组件和动画进度。交互页面以 elapsed time 驱动动画，逐帧导出将 frame 换算为同一时间输入，避免维护两套视觉行为。

导出能力是架构要求，Remotion 是当前实现。修改宿主入口时不得破坏导出；替换导出实现时也应保留相同的输入契约和展示语义。

### 视觉语义

可视化采用深色数据监控台方向，强调高信息密度和分析可读性，不采用营销页、游戏 HUD 或高装饰性视觉。CDF 曲线是主视觉信号，网格、坐标轴和动画保持克制。

统计 marker 使用颜色和视觉权重表达分位位置及尾部风险。终止原因颜色只表示原因之间的对应关系，不表达好坏。文案使用通用的“模拟结果分布”“累计占比”“结束时的 `<item name>`”“累计模拟次数”和简短的分位说明；`unit` 只由展示字段提供。

### 交互缩放

交互页面将固定 3840×2160 画布按宿主可用区域等比缩小并双向居中，窗口尺寸变化时重新适配并避免自动缩放产生滚动条，不放大超过原始画布尺寸。独立浏览器入口保留浏览器原生缩放；用户主动放大后允许滚动查看。Electron 当前只提供自动适配，不提供手动缩放控件。素材导出继续使用原始画布尺寸，不经过交互宿主缩放。

### 输入契约

`docs/schemas/analysis_v2.schema.json` 和 `docs/schemas/display_config.schema.json` 是共享结构契约。`result_item.id`、`total` 和 `runs` 来自 AnalysisV2；`result_item_name` 只控制展示名称。旧字段不做隐式兼容；需要兼容时应明确修改契约和迁移策略。

## 维护边界

- 修改输入结构时，同步更新 JSON schema、`types/`、`data/` 中的校验规则和相关测试。
- 修改 CDF、marker、统计分组或布局计算时，优先在 `data/` 或 `view/` 维护，不把计算散入组件。
- 修改动画节奏时，集中修改 `animation/`，保证 Electron 展示和导出继续使用同一时间轴。
- 修改画布规格或共享视觉 token 时，同时检查交互展示、Remotion composition、导出结果和相关文档。
- Electron 接入只负责提供输入和承载共享画面，不复制输入校验、normalize、view model 或导出逻辑。
- 当前 Remotion 是导出层依赖；使用或分发导出功能前，需要确认使用场景符合其许可证条款。

开发、构建、导出和检查命令统一记录在 `README.md` 与 `docs/DEVELOPMENT_CHECKS.md`。
