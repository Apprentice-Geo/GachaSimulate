# Visualize Frontend Implementation

本文档记录 `src/visualize` 当前前端实现，面向后续维护。

## 运行入口

- `main.tsx`：React 入口，挂载 `App`，加载 `tokens.css`、`globals.css`、`layout.css`。
- `App.tsx`：页面编排层。负责输入加载状态、文件导入、URL 参数输入、动画重放状态，以及把 normalized input 转成 view model 后传给组件。

## CLI

- `pnpm run dev`
  - 启动 Vite dev server。

- `pnpm run typecheck`
  - 执行 TypeScript 类型检查，不生成构建产物。

- `pnpm run build`
  - 先执行 TypeScript 类型检查，再使用 Vite 生成生产构建产物。

- `pnpm run preview`
  - 启动 Vite preview server，预览 `build` 后的 `dist/` 产物。

- `pnpm run test:e2e`
  - 执行 Playwright 端到端测试。

- `pnpm run export:cdf -- --input <json文件路径>`
  - 执行 CDF 可视化素材导出。
  - 默认输出 `cdf-result.png` 和 `cdf-animation.mp4` 到 `outputs/`。
  - 使用 Remotion 逐帧渲染固定 3840x2160、60fps 的 CDF composition，不再通过 Playwright 录屏生成视频。

## 数据流

1. `App` 从 URL 的 `input` 参数或用户选择的 JSON 文件读取数据。
2. `data/load_input.ts` 调用 `validate_input` 做 schema 校验和业务规则校验。
3. `data/normalize_input.ts` 把原始输入转为 `NormalizedVisualizeInputData`，生成 CDF 点和 X 轴范围。
4. `view/cdf_view_model.ts` 补充展示用的 metrics、markers、cost，形成 `NormalizedVisualizeData`。
5. 页面组件只消费 `NormalizedVisualizeData` 或其子集，不直接解析原始输入。

## 动画进度映射

`animation/progress.ts` 以 elapsed ms 为唯一输入，按 `animation/timeline.ts` 的阶段输出组件需要的样式进度。当前映射如下：

| 阶段 | 时间段 | 目标属性 |
| --- | --- | --- |
| top bar | 100ms-300ms | `opacity`、`translateY` |
| chart shell | 300ms-500ms | `opacity`、`translateY` |
| chart surface | 500ms-700ms | Recharts surface 的 `opacity`、`translateY` |
| CDF curve | 700ms-1600ms | SVG path `strokeDashoffset` |
| marker line | 1000ms 起，按 marker 60ms 错峰 | marker line 的 `opacity`、`scaleY` |
| marker point/label | 1400ms 起，按 marker 60ms 错峰 | point/label 的 `opacity`、`translateY` |
| mean line | 1400ms-1600ms | horizontal line 的 `opacity`、`scaleX` |
| termination panel | 1800ms-2000ms | footer panel 的 `opacity`、`translateY` |
| PK fill | 2000ms-2500ms | PK segment 的 `scaleX` |
| termination detail | 2300ms-2500ms | reason list 的 `opacity`、`translateY` |
| stat panel | 2500ms-2800ms | statistic panel 的 `opacity`、`translateY` |
| stat content | 2800ms 起，按 row 50ms 错峰 | group heading/metric row 的 `opacity`、`translateX` |
| note | 3300ms-3400ms | page note 的 `opacity`、`translateY` |

## 目录职责

- `animation/`：动画时间轴常量和 frame-driven progress 计算。页面重放和 Remotion 导出共用同一套进度计算。
- `components/`：React 组件。组件负责渲染和交互，不应包含输入校验或业务数据规范化。
- `data/`：输入读取、schema 校验、业务规则校验、CDF 基础数据构造和 normalized input 生成。
- `export/`：Remotion renderer 导出脚本，负责读取输入 JSON 并生成 PNG、MP4 产物。
- `fixtures/`：示例输入 JSON。
- `hooks/`：可复用 React hook。目前包含图表容器尺寸测量。
- `remotion/`：CDF Remotion composition、root 注册和固定视频规格。
- `styles/`：设计 token、全局样式、页面布局和动画样式。
- `test/`：轻量单测和 e2e 启动脚本。
- `types/`：前端 TypeScript 类型定义。
- `view/`：展示模型、展示顺序、颜色、marker 布局等与视图相关但不直接渲染 DOM 的逻辑。

## 文件职责

- `VisualizeScene.tsx`：ready 状态下的主视觉组件，供网页预览和 Remotion composition 共用。
- `animation/progress.ts`：把 elapsed ms 转成各动画段的 opacity、transform、scale 和曲线绘制进度。
- `animation/timeline.ts`：定义页面动画每个阶段的延迟和时长。
- `components/CDFChart.tsx`：CDF 图表外壳，配置 Recharts 坐标轴、网格、尺寸和坐标格式化。
- `components/CDFOverlay.tsx`：在 Recharts 图表内渲染自定义 SVG CDF 阶梯曲线、marker 线、点和标签。
- `components/cdf_marker_visuals.ts`：按 marker 权重集中定义线宽、点半径、字号、透明度。
- `components/EmptyState.tsx`：无输入时的占位状态。
- `components/ErrorState.tsx`：输入读取或校验失败时的错误展示和重新导入入口。
- `components/ImportButton.tsx`：JSON 文件选择按钮。
- `components/LoadingState.tsx`：输入读取中的状态展示。
- `components/ReplayButton.tsx`：动画重放按钮。
- `components/StatisticPanel.tsx`：右侧统计量面板，按统计分组渲染 metric row。
- `components/TerminationBar.tsx`：底部达成情况分布条和终止原因图例。
- `components/TopBar.tsx`：顶部标题、模拟元信息、导入和重放操作。
- `data/cdf.ts`：生成 CDF 曲线点，按抽数查询 CDF level，生成 marker 原始数据。
- `data/load_input.ts`：从未知值、文件、项目路径加载输入，并串联校验和规范化。
- `data/normalize_input.ts`：把 `VisualizeInput` 转为渲染前的 normalized data。
- `data/validate_input.ts`：使用 `docs/schemas/visualize_input.schema.json` 和业务规则校验输入。
- `export/export_cdf.ts`：读取输入 JSON，构建 view model，调用 Remotion `bundle`、`selectComposition`、`renderMedia` 和 `renderStill` 导出 MP4/PNG。
- `export/paths.ts`：解析项目内路径、创建输出目录、清理旧导出产物。
- `hooks/use_element_size.ts`：基于 `ResizeObserver` 测量元素尺寸。
- `remotion/CdfComposition.tsx`：根据 Remotion frame/fps 计算 elapsed ms 并渲染 `VisualizeScene`。
- `remotion/Root.tsx`：注册固定 3840x2160、60fps、CDF composition。
- `remotion/constants.ts`：集中定义 Remotion composition ID、尺寸、帧率和时长。
- `test/cdf.test.ts`：覆盖 CDF 查询、曲线路径、marker 布局、展示配置和 view model。
- `test/run_e2e.ts`：启动 Vite dev server 后运行 Playwright 测试。
- `types/visualize_input.ts`：原始输入、normalized input、view model、marker、metric 等类型。
- `view/cdf_overlay_layout.ts`：根据 Recharts scale 计算 overlay 坐标、标签位置和阶梯曲线路径。
- `view/cdf_view_config.ts`：CDF marker 和图表坐标轴展示配置。
- `view/cdf_view_model.ts`：把 normalized input 组装成组件消费的完整展示模型。
- `view/statistic_view_config.ts`：统计量展示顺序、分组、描述和终止原因颜色配置。
- `vite-env.d.ts`：Vite 环境类型声明。

## 视觉风格

当前实现的视觉风格是深色数据监控台，而不是营销页、游戏 HUD 或通用 BI 后台。整体方向为 “Sentry 深色监控台 + 少量 NVIDIA 科技终端细节”，并借用了 `reference/Sentry.md` 的深紫黑画布、细边框暗色卡片、克制高亮，以及 `reference/NVIDIA.md` 的工程化几何、绿色角标和低装饰密度。

主画布固定为 3840x2160，使用 `#120d1f` 深紫黑背景和 96px 网格纹理。页面采用小圆角、细边框、暗色面板和轻量内高光来建立层级：主面板背景为 `#1b142b`，次级面板为 `#211936`，边框主要来自 `#362d59` / `#51436f`。阴影存在但较克制，用于让图表、统计面板和底部达成情况区域从暗色背景中略微抬起。

色彩层级以信息可读性优先。主文字是高对比浅紫白 `#f7f3ff`，次级和弱提示文字使用透明度递减的浅色。CDF 主曲线固定为 Cyan `#22d3ee`，是画面里最强的视觉信号；网格、坐标轴和刻度保持低对比，辅助读数但不抢占曲线。NVIDIA 绿 `#76b900` 没有作为大面积品牌底色使用，只出现在左上角标、标题 kicker、状态图标和部分统计标记上。

CDF 标记采用多色风险谱系，并通过 `view/cdf_view_config.ts` 和 `components/cdf_marker_visuals.ts` 控制颜色与权重。低抽数一侧使用深绿/绿，P50 使用浅绿强调中位数，MEAN 使用紫色，P75/P95/MAX 使用橙到红表达尾部风险。虚线、交点和标签的视觉权重按统计重要性区分：P50 最强，MEAN/P95/MAX 次之，P25/P75 居中，MIN/P5 最弱。

版式是信息密度较高的单页导出画面。顶部标题区左侧显示 `CDF ANALYSIS`、标题和元信息，右侧放置重放与导入操作；主区域使用左侧 CDF 图表、右侧统计面板的布局，当前 CSS 比例为 `80fr / 20fr`。右侧统计面板按低抽数区间、中抽数区间、高抽数区间分组，指标卡用左侧彩色边条对应 marker 颜色，避免大量填色造成噪声。底部只保留达成情况分布条和图例，不再展示额外装饰区块。

终止原因 PK 条延续 `VISUALIZE_DEVELOP.md` 的中性语义约束：颜色固定为 Sentry Violet Link `#6a5fc1` 与 Hot Pink `#fa7faa`，只表达原因对应关系，不表达好坏。两段比例条交界使用左斜 45 度斜切，避免垂直分割线带来的普通报表感。

动画风格同样克制。页面使用淡入、轻微位移、曲线绘制、虚线展开、统计卡片侧向进入和 PK 条填充，不使用夸张弹跳、强粒子、大片 glow 或 sticker/mascot。装饰只服务分析平台的技术感和信息层级。

## 维护边界

- 修改输入结构时，同步更新 `docs/schemas/visualize_input.schema.json`、`types/visualize_input.ts`、`data/validate_input.ts` 的业务规则和相关测试。
- 修改统计量展示顺序或分组时，优先改 `view/statistic_view_config.ts`。
- 修改 CDF marker 的颜色或权重时，优先改 `view/cdf_view_config.ts`；修改线宽、字号、点大小时，优先改 `components/cdf_marker_visuals.ts`。
- 修改 marker 标签避让或阶梯曲线路径时，优先改 `view/cdf_overlay_layout.ts`，并补充 `test/cdf.test.ts`。
- 修改动画节奏时，优先改 `animation/timeline.ts` 和 `animation/progress.ts`，避免在组件或 CSS 中新增散落的时间常量。
- 修改导出规格时，同步更新 `remotion/constants.ts`、README 和本文档；首版导出不暴露 codec、crf、concurrency 等高级 CLI 参数。
- Remotion 是导出层依赖；分发或复用导出功能前，需要确认使用场景符合 Remotion 当前许可证条款。
- 组件中新增逻辑前先判断是否属于 `data/`、`view/` 或 `hooks/`，保持组件偏渲染、低业务耦合。
