# Visualization Design

本文维护 ResultEditor CDF Preview、正式结果可视化与 Export Frame 的现有独立暗色设计。Workbench 导航、表单、编辑器外壳与导出对话框遵循 [Workbench Design](WORKBENCH_DESIGN.md)。模块边界见 [Architecture](../ARCHITECTURE.md)，输入契约见 [Analysis JSON](ANALYSIS.md) 与 [DisplayConfig](DISPLAY_CONFIG.md)。

Visualization 采用深色数据监控台方向，强调精确、硬朗和克制。CDF 曲线是主视觉信号，统计指标和终止原因用于补充解释。直角卡片与有主次的细边框建立结构；低对比背景、纹理和动效让位于信息，不向营销页、游戏 HUD 或高装饰性画面发展。不随 Workbench 主题变化。

## 设计参考与取舍

项目保留两份第三方设计分析资料，仅作为 Result Visualization、CDF、Statistics、Termination 和 Export Frame 的视觉参考。ResultEditor 内嵌 CDF Preview 同样遵循这些参考；Workbench 的导航、表单、配置仓库和编辑器外壳不受其视觉规则约束：

| 参考 | 本项目采用的方向 | 适用边界 |
| --- | --- | --- |
| [NVIDIA design analysis](reference/DESIGN-nvidia.md) | 硬朗几何与细线分隔 | 不引入其营销页面结构、品牌专用字体或整套组件规格 |
| [Sentry design analysis](reference/DESIGN-sentry.md) | 紫黑底色、分层深色表面与明亮点缀 | 不引入其插画主导、大幅营销标题和明暗页面切换规则 |

参考材料中的 token、字体、断点和组件规则不自动成为项目规范。项目使用自己的颜色语义、中文排版和数据表达；参考资料更新也不意味着需要同步改变 UI。这些资料是第三方分析与演绎，不作为品牌官方规范。

参考资料来源与版权声明集中记录在 [Third-party notices](../THIRD_PARTY_NOTICES.md)，许可证正文见 [awesome-design-md MIT License](../third_party/licenses/awesome-design-md-MIT.txt)。字体授权同样由第三方声明索引，本文不重复维护许可证正文。

## Visualization 视觉语言

### 表面与颜色

三个 Visualization 宿主共享紫黑底色与直角面板的仪器台视觉语言。CDF 以低对比细边界和四角强调与预览宿主背景区分，边界不占用图表布局空间。曲线的亮度高于边框，统计区仅 P50、P95 使用强调表面，其余统计行以分隔线组织。面板通过表面色与边界区分层级，背景纹理保持低对比，不干扰正文和图表。

颜色按职责使用：

- 绿色用于页头品牌标识；金色用于 P50，浅蓝用于 P95，区分关键读数。
- 青色用于数据及选中反馈，CDF 曲线保持突出。
- 主要文字、次要说明和弱提示使用不同文字层级；普通标识符使用次要文字色。
- 分位 marker 的颜色与视觉权重表达阅读层级，不表达好坏或风险。MIN、MAX 为中性端点；MEAN 使用淡紫色空心菱形区别于分位圆点。
- 终止原因使用独立分类色组，只表示原因之间的对应关系，不表达好坏。

共享颜色、字体和画布 token 由 [Visualization tokens](../src/visualize/styles/tokens.css) 管理，统一限定在 `.visualize-scope`。三个宿主加载同一 [Visualization 样式入口](../src/visualize/styles/index.css)，Preview 仅按可用空间缩小共享 CDF 设计坐标，不独立维护颜色、字体、刻度、marker 或 compact 样式。正式页面与导出复用 `VisualizeScene`，仅宿主适配和动画驱动不同。

Workbench 主题与组件规范见 [Workbench Design](WORKBENCH_DESIGN.md)；[Workbench 样式](../src/renderer/styles.css) 的 scope 在 `.visualize-scope` 边界停止匹配。[foundation](../src/styles/foundation.css) 只提供字体资源、box-sizing、基础 reset 和控件字体继承。CSS import 的组件位置不提供隔离保证。Export HTML 的 body 直接建立 Visualization scope，导出宿主独立负责固定尺寸与无滚动约束，不从 React 子树反向读取变量。具体色值、间距和组件尺寸不在本文维护第二份清单。

### 字体与数值排版

Visualization 中文使用思源黑体 Regular、Medium、Bold，数字与标识符使用 JetBrains Mono Regular、SemiBold，关闭编程连字。数字字体由 Visualization token 管理，三个宿主使用相同字体资源。Workbench 当前复用这些字体资源，但由自己的 token 决定字体选择。

单位继续使用思源黑体，并降低字号与字重，使数值保持主要阅读权重。正文、说明与统计数字的层级通过字号、字重和文字色共同建立，不以整段强调色替代层级。

## 结果画布

编辑器标题下方的预览内容区使用 Workbench 白色卡片表面，图表本身保持独立暗色。正式可视化画布外围保留静态黑底白色星空；星点使用固定坐标，以暗小点为主、少量亮点为辅，不闪烁、不视差、不随图表缩放。标题栏保持 Workbench 样式，结果画布内部使用紫黑背景与低对比网格。外围星空不进入 PNG 或视频，不扩大导出尺寸或留白。

CDF、核心统计量与达成路径面板使用低对比中性边界，CDF 额外使用四角强调，主曲线保持更高亮度。面板使用直角，无整圈光晕；使用独立 surface 或向内覆盖，不改变内容测量、绘图区与刻度，不叠加内容透明度动画。统计行边线与对应 marker 同色，仅表示对应关系。预览不添加宿主外框，共享边框随画布进入导出。

结果画布保持固定设计坐标，由 [Visualization tokens](../src/visualize/styles/tokens.css) 与 [scene layout](../src/visualize/view/scene_layout.ts) 维护尺寸。Electron 按宿主可用区域等比缩小并双向居中，窗口变化时重新适配，不放大超过原始尺寸，不提供手动缩放。宿主间距以 [preview styles](../src/visualize/styles/preview.css) 为准。该规则不用于整个桌面工作空间。

CDF 与下方达成路径分布共用左列，右侧统计量面板顶部与 CDF 对齐、底部与达成路径分布对齐，顶部信息沿用相同列划分。具体尺寸和间距由上述源码维护，不在本文复制。

素材导出使用原始画布尺寸，不经过交互宿主缩放。图表读取共享布局实际分配的区域尺寸，导出不单独指定图表尺寸。展示适配不能改变导出画面的布局和数据表达。画面内不放置工作台操作栏；更换结果、重播与导出入口由 Workbench 侧栏提供。


## 数据表达与文案

CDF 曲线、坐标、marker 和统计指标组成同一套阅读层级。网格与坐标轴是辅助参照，不能压过曲线；marker 和统计分组的视觉变化应保持数值含义一致。

使用通用文案：“模拟结果分布”“累计占比”“结束时的 `<item name>`”“累计模拟次数”，并配合简短的分位说明。结果名称来自展示配置，避免将某一种统计物品固化为所有场景的文案。

展示单位只追加到累计结果和统计指标的展示值；CDF 坐标轴标题与刻度保持无单位。单位和名称的调整只改变展示，不改变统计数据。字段职责与数据来源见 [DisplayConfig](DISPLAY_CONFIG.md)。

## 动效与导出一致性

动效用于引导信息出现和建立阅读顺序，保持克制。共享动画采用 linear、ease-out quadratic 和 ease-out cubic 三类缓动，由各时间段明确选择；具体时长与进度计算集中维护在动画实现中。

有独立内容动画的容器不得再对祖先 opacity 做动画。面板背景、边框和阴影使用与内容并列的 surface 层，避免父子透明度叠乘导致内容意外变暗。

交互展示和逐帧导出必须保持同一套视觉行为；静态 PNG 与视频完成后的画面一致，切换时不发生布局或动画跳变。帧范围、终态帧和导出入口约束见 [Architecture](../ARCHITECTURE.md#可视化与导出)。

## 维护与验证入口

修改共享画面时同步检查编辑器预览、正式可视化与导出结果，保持相同字体、数据表达和动画终态。设计数值以 token 和场景布局源码为权威，不维护第二份数值表。布局测试保护几何和适配，截图检查视觉层级，实际导出验证共享画面；命令与验证要求见 [Development Checks](DEVELOPMENT_CHECKS.md)。
