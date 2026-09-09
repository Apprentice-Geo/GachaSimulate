# Visualize Frontend Implementation

本文档记录 `src/visualize/` 的稳定职责、设计决策和维护边界。具体组件、动画时长和样式数值以源码为准，不在这里维护逐文件镜像。

## 定位

`src/visualize/` 是平台无关的结果可视化层。它把 `Analysis + DisplayConfig v2` 转换为经过校验的展示模型，供 Electron 和素材导出使用。Remotion bundler/renderer 和旧导出进程入口位于 `src/export/`；Electron 自研导出宿主位于 `src/main/` 与 `src/export-renderer/`。这些宿主只依赖本层，不被本层反向依赖。

素材导出是长期保留能力。迁移期间并存 Electron 展示、内部 Electron 逐帧导出与 Remotion 导出；Remotion 只在后续安装包验收和性能评审通过后移除。

Electron 的导航、模拟表单、GSR 对话框、analyzer 进程、结果编辑页和结果可视化页属于 `src/renderer/`、`src/preload/` 与 `src/main/`，不得进入 `src/visualize/`。反过来，`src/visualize/` 不依赖 Electron 或 Node.js API。

## 数据流

稳定的数据流是：

```text
Analysis -------> validate_analysis -----------+
                                               +-> build_cdf_view_model
DisplayConfig -> validate_display_config ------+   (safe-integer conversion + merge)
                                                   -> CDF view model
                                                   -> shared scene
                                                   -> Electron display, Electron export, or Remotion export
```

Analysis 和 DisplayConfig 不能绕过各自校验直接进入视图模型。组件只消费 CDF view model，不承担 schema 校验、数值转换、CDF 计算或展示规则编排。

Electron 的结果编辑页和结果可视化页共享当前 GSR 会话。main 调用 C++ analyzer 并校验 Analysis；编辑页只保存 DisplayConfig v2，可视化页用 `Analysis + DisplayConfig` 生成共享视图模型。DisplayConfig v1、旧字段和旧完整 JSON 不做隐式兼容。

桌面素材导出入口通过 `VisualizeShell` 的宿主回调接入；可视化层只呈现固定操作按钮、可用状态和辅助技术可读的禁用原因，不接收 session id、GSR 文件名、reservation、目录或任务路径。格式、目标选择、覆盖及任务交互由桌面 renderer 与 main 负责。

## 模块地图

- `data/`：Analysis、DisplayConfig 校验和 CDF 基础计算。
- `view/`：展示模型、统计配置和与画面有关的布局计算。
- `components/`：共享画面与交互组件，保持偏渲染。
- `animation/`：交互展示和逐帧导出共用的时间轴与进度计算。
- `styles/`：共享设计 token、画面样式和宿主外壳样式。
- `remotion/`：复用共享场景的 Remotion composition。
- `src/export/`：位于可视化层之外的 Node.js 素材导出宿主。
- `src/export-renderer/`：位于可视化层之外的固定尺寸 Electron 导出页面与逐帧提交边界。
- `src/main/export_host.ts`：位于可视化层之外的 CDP、FFmpeg 和输出提交宿主。
- `types/`：Analysis、DisplayConfig 和 CDF view model 类型。

重要符号包括 `Analysis`、`DisplayConfig`、`build_cdf_view_model` 和 `VisualizeScene`。需要定位具体实现时，优先搜索这些符号及上述模块，而不是依赖本文档中的文件清单。

## 设计决策

### 展示与导出共享

Electron 展示和素材导出复用同一套输入处理、视图模型、画面组件和动画进度。共享动画使用 60 FPS 帧制时间轴；交互页面仍以 elapsed time 调用共享进度入口，由入口换算为浮点帧进度，逐帧导出也换算为同一时间输入，避免维护两套视觉行为。

导出能力是架构要求。Electron 自研导出和迁移期保留的 Remotion 必须使用同一输入契约与共享逐帧语义；替换宿主不得复制或分叉画面逻辑。

共享动画只使用 linear、ease-out quadratic 和 ease-out cubic 三类缓动，并由每个时间段显式选择。带独立内容动画的容器不得再动画祖先 opacity；面板背景、边框和阴影应由与内容并列的 surface 层承载，避免父子透明度叠乘。

`resolve_export_frame_state` 是逐帧语义的唯一入口，只接受 0–59 的整数帧。动画在 `ANIMATION_COMPLETION_FRAME` 到达终态，当前值为第 57 帧；第 57–59 帧保持相同 idle 终态，静态 PNG 使用第 57 帧。Electron 自研导出与 Remotion 均消费这项契约，从视频切换到 PNG 时不得出现布局或动画跳变。

### 视觉语义

可视化采用深色数据监控台方向，强调高信息密度和分析可读性，不采用营销页、游戏 HUD 或高装饰性视觉。CDF 曲线是主视觉信号，网格、坐标轴和动画保持克制。

统计 marker 使用颜色和视觉权重表达分位位置及尾部风险。终止原因颜色只表示原因之间的对应关系，不表达好坏。文案使用通用的“模拟结果分布”“累计占比”“结束时的 `<item name>`”“累计模拟次数”和简短的分位说明；`result_item_unit` 只追加到累计结果和统计指标展示值，CDF 坐标轴标题与刻度保持无单位。

### 交互缩放

Electron 将固定 3840×2160 画布按宿主可用区域等比缩小并双向居中，窗口尺寸变化时重新适配并避免自动缩放产生滚动条，不放大超过原始画布尺寸。Electron 当前不提供手动缩放控件。素材导出继续使用原始画布尺寸，不经过交互宿主缩放。

`VisualizeScene` 通过 `render_mode` 区分交互与导出。export 模式固定图表尺寸并强制隐藏操作栏，不调用页面缩放 hook、真实时钟动画或宿主缩放。

### 输入契约

`Analysis + DisplayConfig v2` 是唯一可视化输入契约，对应 `docs/schemas/analysis.schema.json` 和 `docs/schemas/display_config.schema.json`。`result_item.id`、`totals.result` 和 `totals.runs` 来自 Analysis；`result_item_name` 只控制展示名称，`subtitle` 控制主标题下的可选副标题，`result_item_unit` 控制累计结果和统计指标的展示单位。DisplayConfig v1、旧完整 JSON 和旧字段不做隐式兼容；需要兼容时应明确修改契约和迁移策略。

JSON Schema 是字段、类型、必填项和局部取值约束的权威。`validate_analysis` 另行定义数组长度、递增顺序、CDF 终点和 termination 比例等跨字段不变量；`validate_display_config` 当前只执行对应 Schema，没有额外语义规则。`types/` 中的 TypeScript 类型是消费方的静态视图，不独立定义格式。

## 维护边界

- 修改输入结构或跨字段不变量时，同步更新对应 JSON Schema、semantic validator、`types/`、共享 fixture 和相关测试；没有额外语义规则时不为 validator 重复实现 Schema 约束。
- 修改 CDF、marker、统计分组或布局计算时，优先在 `data/` 或 `view/` 维护，不把计算散入组件。
- 修改动画节奏时，集中修改 `animation/`，保证 Electron 展示和导出继续使用同一时间轴。
- 修改画布规格或共享视觉 token 时，同时检查交互展示、Electron 导出 renderer、Remotion composition、导出结果和相关文档。
- Electron 接入只负责提供输入和承载共享画面，不复制输入校验、view model 或导出逻辑。
- 修改可视化操作栏中的导出入口时，保持按钮固定占位、hover/focus-within 展示和禁用原因可读；导出流程状态与模态框不得进入 `src/visualize/`。
- Remotion 是迁移期保留的导出层依赖；Electron MP4 路径在阶段 1–3 使用固定哈希的 Windows x64 第三方 FFmpeg，不得回退到 PATH，且当前不得进入安装包。发布边界和解除条件见 `docs/FFMPEG_DISTRIBUTION.md`。

开发、构建、导出和检查命令统一记录在 `README.md` 与 `docs/DEVELOPMENT_CHECKS.md`。
